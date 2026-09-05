import { createClient } from "@supabase/supabase-js";

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function getMetaError(data) {
  return data?.error?.message || "WhatsApp API error";
}

async function getWhatsAppConnection(supabase, env) {
  const { data, error } = await supabase
    .from("whatsapp_connections")
    .select("phone_number_id, access_token")
    .eq("id", "raidenceai")
    .maybeSingle();

  if (error) {
    console.error("WHATSAPP CONNECTION LOOKUP ERROR:", error);
  }

  return {
    phoneNumberId: data?.phone_number_id || env.PHONE_NUMBER_ID,
    accessToken: data?.access_token || env.WHATSAPP_TOKEN,
  };
}

export async function onRequestPost(context) {
  try {
    const supabase = createClient(
      context.env.SUPABASE_URL,
      context.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const body = await context.request.json();
    const phone = cleanPhone(body.to);
    const message = String(body.message || "").trim();

    if (!phone || !message) {
      return Response.json(
        {
          success: false,
          step: "validation",
          error: "Missing phone or message",
        },
        {
          status: 400,
        },
      );
    }

    const { phoneNumberId, accessToken } = await getWhatsAppConnection(
      supabase,
      context.env,
    );

    if (!phoneNumberId || !accessToken) {
      throw new Error("No active WhatsApp connection found");
    }

    const response = await fetch(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: {
            body: message,
          },
        }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      const errorMessage = getMetaError(data);
      const errorCode = data?.error?.code || null;

      await supabase.from("messages").insert({
        wa_message_id: null,
        phone,
        direction: "outgoing",
        message_type: "system",
        message: `Reply failed: ${errorMessage}`,
        status: "failed",
        error_message: errorMessage,
        error_code: errorCode,
      });

      return Response.json(
        {
          success: false,
          step: "send_text",
          error: errorMessage,
        },
        {
          status: 400,
        },
      );
    }

    await supabase.from("messages").insert({
      wa_message_id: data.messages?.[0]?.id || null,
      phone,
      direction: "outgoing",
      message_type: "text",
      message,
      status: "accepted",
    });

    await supabase.from("conversations").upsert(
      {
        phone,
        last_message: message,
        last_message_at: new Date().toISOString(),
      },
      {
        onConflict: "phone",
      },
    );

    return Response.json({
      success: true,
      message: "Message accepted by WhatsApp",
      data,
    });
  } catch (error) {
    console.error("SEND REPLY ERROR:", error);

    return Response.json(
      {
        success: false,
        step: "server_error",
        error: error.message,
      },
      {
        status: 500,
      },
    );
  }
}
