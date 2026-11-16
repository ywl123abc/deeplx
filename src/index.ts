/**
 * DeepLX - Adapted for Snow Shot & Multi-format Clients
 */

import { Hono } from "hono";
import {
  clearMemoryCache,
  generateCacheKey,
  getCachedTranslation,
  query,
  setCachedTranslation,
} from "./lib";

import { PAYLOAD_LIMITS } from "./lib/config";
import { createErrorResponse } from "./lib/errorHandler";
import { normalizeLanguageCode } from "./lib/query";
import {
  getSecureClientIP,
  handleCORSPreflight,
  validateLanguageCode,
} from "./lib/security";
import { translateWithGoogle } from "./lib/services/googleTranslate";
import { createStandardResponse } from "./lib/types";

const app = new Hono<{ Bindings: Env }>();

function isDebugModeEnabled(value?: string): boolean {
  if (!value) {
    return false;
  }
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): void {
  ctx.waitUntil(handleScheduled(event, env));
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  clearMemoryCache();
}

const worker = {
  fetch: app.fetch,
  scheduled,
};

export default worker;

/**
 * 兼容各类客户端的语言代码清洗（例如把 zh-CN / zh-Hans 转为 ZH）
 */
function cleanClientLang(lang: any, fallback: string): string {
  if (!lang || typeof lang !== "string") {
    return fallback;
  }
  const base = lang.trim().split("-")[0].split("_")[0];
  return validateLanguageCode(base) || fallback;
}

/**
 * Common translation handler function
 */
async function handleTranslation(c: any, provider: "deepl" | "google") {
  const env = c.env;
  const clientIP = getSecureClientIP(c.req.raw) || "unknown";

  try {
    let params;
    try {
      params = await c.req.json();
    } catch (parseError) {
      return c.json(createStandardResponse(400, null), 400);
    }

    if (!params || typeof params !== "object") {
      return c.json(createStandardResponse(400, null), 400);
    }

    // 兼容 text 字符串、texts 数组、q 字段等多种客户端格式
    let rawText = "";
    const isArrayRequest = Array.isArray(params.texts);
    if (typeof params.text === "string") {
      rawText = params.text;
    } else if (isArrayRequest) {
      rawText = params.texts.join("\n");
    } else if (typeof params.q === "string") {
      rawText = params.q;
    }

    if (!rawText || !rawText.trim()) {
      return c.json(createStandardResponse(400, null), 400);
    }

    let sanitizedText = rawText;
    if (sanitizedText.length > PAYLOAD_LIMITS.MAX_TEXT_LENGTH) {
      sanitizedText = sanitizedText.slice(0, PAYLOAD_LIMITS.MAX_TEXT_LENGTH);
    }

    // 宽松解析源语言和目标语言，避免因 zh-CN 等后缀报 400
    const sourceLang = cleanClientLang(params.source_lang || params.source, "auto");
    const targetLang = cleanClientLang(params.target_lang || params.target, "zh");

    const normalizedSourceLang = normalizeLanguageCode(sourceLang);
    const normalizedTargetLang = normalizeLanguageCode(targetLang);
    const cacheKey = generateCacheKey(
      sanitizedText,
      normalizedSourceLang,
      normalizedTargetLang,
      provider
    );
    const cached = await getCachedTranslation(cacheKey, env);

    if (cached) {
      const cachedResp: any = createStandardResponse(
        200,
        cached.data,
        cached.id || Math.floor(Math.random() * 10000000000),
        cached.source_lang,
        cached.target_lang
      );
      if (isArrayRequest) {
        cachedResp.translations = cached.data.split("\n").map((t: string) => ({ text: t }));
      }
      return c.json(cachedResp);
    }

    const validatedParams = {
      text: sanitizedText,
      source_lang: normalizedSourceLang,
      target_lang: normalizedTargetLang,
    };

    let result: any;

    if (provider === "google") {
      result = await translateWithGoogle(validatedParams, { env, clientIP });
    } else {
      result = await query(validatedParams, { env, clientIP });
    }

    if (result.code === 200 && result.data) {
      await setCachedTranslation(
        cacheKey,
        {
          data: result.data,
          timestamp: Date.now(),
          source_lang:
            result.source_lang || validatedParams.source_lang.toUpperCase(),
          target_lang:
            result.target_lang || validatedParams.target_lang.toUpperCase(),
          id: result.id,
        },
        env
      );
      if (isArrayRequest) {
        result.translations = result.data.split("\n").map((t: string) => ({ text: t }));
      }
    }

    return c.json(result, result.code as any);
  } catch (error) {
    const errorResponse = createErrorResponse(error, {
      endpoint: `/${provider}`,
      clientIP,
    });

    return c.json(errorResponse.response, errorResponse.httpStatus as any);
  }
}

/**
 * API Route Definitions
 */
app
  .options("*", (c) => handleCORSPreflight(c))
  .get("/translate", (c) => c.text("Please use POST method :)"))
  .get("/deepl", (c) => c.text("Please use POST method :)"))
  .get("/google", (c) => c.text("Please use POST method :)"))
  .post("/deepl", (c) => handleTranslation(c, "deepl"))
  .post("/translate", (c) => handleTranslation(c, "deepl"))
  .post("/google", (c) => handleTranslation(c, "google"))
  .post("/debug", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ received: body });
  });
