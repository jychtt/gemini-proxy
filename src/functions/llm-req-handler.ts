import { Env } from "../types";
import { DurableObjectStub, ExecutionContext } from "@cloudflare/workers-types";
import { ApiHandler } from "../llm-api-adapter/base";
import apiManager from "../llm-api-adapter/api-manager";
import { getApiKey, handleUpstream429 } from "./key-helpers";

/**
 * Main handler for proxying API requests with key rotation and retries.
 */
export async function handleApiProxy(request: Request, env: Env, ctx: ExecutionContext, useInternalKeyManager: boolean, handler: ApiHandler, modelName: string): Promise<Response> { // Ensure Request/ExecutionContext/Response use imported types
    console.log(`[handleApiProxy] Request received: ${request.method} ${request.url}, useInternalKeyManager: ${useInternalKeyManager}`);
    const doId = env.API_KEY_MANAGER.idFromName("global-api-key-manager");
    const managerStub = env.API_KEY_MANAGER.get(doId);
    const maxRetries = useInternalKeyManager ? 3 : 1; // Only retry if using internal keys
    let retries = 0;

    // Note: Handler determination and model name parsing are now expected to be done before calling this function.
    // The handler and modelName are passed as parameters.

    modelName = modelName === null ? "" : modelName;

    while (retries < maxRetries) {
        let apiKey: string | null = null;

        if (useInternalKeyManager) {
            try {
                apiKey = await getApiKey(managerStub, modelName, handler.apiType);
            } catch (error: any) {
                console.error(`[handleApiProxy] Error getting internal API key for model ${modelName}: ${error.message}`);
                const status = error.message.includes("all API key") ? 429 : 500;
                return new Response(error.message, { status });
            }
        }

        try {

            /**
             * All for difficult debug
             */
            const upstreamRequest = handler.buildUpstreamRequest(request.clone(), apiKey, modelName, env);
            // for (const [key, value] of upstreamRequest.headers.entries()) {
            //     console.log(`[handleApiProxy] req_header ${key}: ${value}`);
            // }
            // console.log(`[handleApiProxy] Sending upstream request to: ${upstreamRequest.url}`);
            // try {
            //     const requestBody = await upstreamRequest.clone().text();
            //     console.log(`[handleApiProxy] Upstream request body: ${requestBody}`);
            // } catch (e) {
            //     console.error(`[handleApiProxy] Failed to log request body: ${e}`);
            // }
            const upstreamResponse = await fetch(upstreamRequest);
            // console.log(`[handleApiProxy] Received upstream response with status: ${upstreamResponse.status}`);
            // console.log(`[handleApiProxy] Upstream response headers:`);
            // for (const [key, value] of upstreamResponse.headers.entries()) {
            //     console.log(`[handleApiProxy]   ${key}: ${value}`);
            // }
            // try {
            //     const responseBody = await upstreamResponse.clone().text();
            //     console.log(`[handleApiProxy] Upstream response body: ${responseBody}`);
            // } catch (e) {
            //     console.error(`[handleApiProxy] Failed to log response body: ${e}`);
            // }

            if (useInternalKeyManager) {
                const normalizedModelName = encodeURIComponent(modelName.split('/').pop() ?? modelName);
                if (upstreamResponse.status === 429) {
                    let reason = "Unknown reason";

                    const responseBody = await upstreamResponse.clone().json();
                    reason = JSON.stringify(responseBody);
                    if (Array.isArray(responseBody) && responseBody.length > 0 &&
                        responseBody[0] && typeof responseBody[0] === 'object' &&
                        responseBody[0].error && typeof responseBody[0].error === 'object' &&
                        responseBody[0].error.status === 'RESOURCE_EXHAUSTED') {
                        // This is a fake RESOURCE_EXHAUSTED
                        console.log(`FAKE RESOURCE_EXHAUSTED for model ${normalizedModelName} by key ${apiKey?.substring(0, 10)}`);
                        retries++;
                        continue;
                    }

                    if (apiKey) {
                        handleUpstream429(apiKey, managerStub, ctx, normalizedModelName, reason); // Pass reason
                    }
                    console.log(`[handleApiProxy] Retrying request for model ${normalizedModelName}... (attempt ${retries + 1}/${maxRetries})`);
                    retries++;
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                }

                if (normalizedModelName != '' && upstreamResponse.ok) {
                    if (apiKey) { // Ensure apiKey is not null before incrementing usage
                        const incrementUrl = `https://internal-do/incrementUsage?key=${encodeURIComponent(apiKey)}&model=${normalizedModelName}`;
                        ctx.waitUntil(
                            managerStub.fetch(incrementUrl, { method: 'POST' })
                                .then(async (res) => {
                                    if (!res.ok) {
                                        console.error(`[handleApiProxy] Failed incr key cnt ${apiKey.substring(0, 10)}... model ${normalizedModelName}: ${await res.text()}`);
                                    }
                                })
                                .catch(err => console.error(`[handleApiProxy] Error calling incrementUsage for key ${apiKey.substring(0, 10)}... model ${normalizedModelName}:`, err))
                        );
                    }
                }
            }


            const responseHeaders = new Headers(upstreamResponse.headers);
            // Remove potentially problematic headers that Cloudflare Workers handles automatically
            responseHeaders.delete('Content-Length');
            responseHeaders.delete('Transfer-Encoding');
            responseHeaders.set('X-Proxied-By', useInternalKeyManager ? 'Cloudflare-Worker' : 'Cloudflare-Worker-Direct'); // Indicate proxy type

            console.log(`[handleApiProxy] Returning response to client with status: ${upstreamResponse.status}`);
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                statusText: upstreamResponse.statusText,
                headers: responseHeaders
            });

        } catch (error: any) {
            console.error(`[handleApiProxy] Error during upstream request for model ${modelName} with key ${apiKey ? apiKey.substring(0, 10) + '...' : 'N/A'}:`, error);
            return new Response(error.message || "Error proxying request to upstream API", { status: 502 }); // Bad Gateway might be appropriate
        }
    }

    console.error(`[handleApiProxy] Maximum number of retries reached (${maxRetries}). Request failed for model ${modelName}.`);
    return new Response(`Unable to process request after ${maxRetries} attempts using different keys for model ${modelName}. All keys may be exhausted for this model or the upstream service is unavailable.`, { status: 503 }); // Service Unavailable
}