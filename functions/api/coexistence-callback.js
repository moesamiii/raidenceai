import { createClient } from "@supabase/supabase-js";

const REDIRECT_URI = "https://raidenceai.pages.dev/connect-whatsapp.html";

const SUCCESS_URL =
  "https://raidenceai.pages.dev/chat.html?coexistence=connected";

async function exchangeAuthorizationCode(code, env) {
  const tokenUrl = new URL(
    "https://graph.facebook.com/v25.0/oauth/access_token",
  );

  tokenUrl.searchParams.set("client_id", env.META_APP_ID);
  tokenUrl.searchParams.set("client_secret", env.META_APP_SECRET);
  tokenUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  tokenUrl.searchParams.set("code", code);

  const tokenResponse = await fetch(tokenUrl);
  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(tokenData.error?.message || "Could not get access token");
  }

  return tokenData.access_token;
}

async function saveWhatsAppConnection(accessToken, env) {
  const wabaResponse = await fetch(
    `https://graph.facebook.com/v25.0/${env.META_BUSINESS_ID}/owned_whatsapp_business_accounts`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const wabaData = await wabaResponse.json();
  const wabaId = wabaData.data?.[0]?.id;

  if (!wabaResponse.ok || !wabaId) {
    throw new Error("Could not find WhatsApp Business Account");
  }

  const phonesResponse = await fetch(
    `https://graph.facebook.com/v25.0/${wabaId}/phone_numbers`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const phonesData = await phonesResponse.json();
  const phoneNumber = phonesData.data?.[0];

  if (!phonesResponse.ok || !phoneNumber?.id) {
    throw new Error("Could not find Phone Number ID");
  }

  const supabase = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const { error: saveError } = await supabase
    .from("whatsapp_connections")
    .upsert(
      {
        id: "raidenceai",
        access_token: accessToken,
        waba_id: wabaId,
        phone_number_id: phoneNumber.id,
        display_phone_number: phoneNumber.display_phone_number || null,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "id",
      },
    );

  if (saveError) {
    throw saveError;
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorReason = url.searchParams.get("error_reason");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return new Response(
      `WhatsApp connection cancelled: ${
        errorReason || errorDescription || error
      }`,
      { status: 400 },
    );
  }

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  try {
    const accessToken = await exchangeAuthorizationCode(code, env);
    await saveWhatsAppConnection(accessToken, env);

    return Response.redirect(SUCCESS_URL, 302);
  } catch (error) {
    console.error("COEXISTENCE CALLBACK ERROR:", error);

    return new Response(`Connection failed: ${error.message}`, {
      status: 500,
    });
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    const body = await request.json();
    const accessToken = body?.accessToken;

    if (!accessToken) {
      return Response.json(
        { ok: false, error: "Missing access token" },
        { status: 400 },
      );
    }

    await saveWhatsAppConnection(accessToken, env);

    return Response.json({
      ok: true,
      redirectUrl: SUCCESS_URL,
    });
  } catch (error) {
    console.error("COEXISTENCE TOKEN SAVE ERROR:", error);

    return Response.json(
      {
        ok: false,
        error: error.message || "Could not save WhatsApp connection",
      },
      { status: 500 },
    );
  }
}
