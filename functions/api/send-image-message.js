import { createClient } from "@supabase/supabase-js";

const MEDIA_BUCKET = "whatsapp-media";

function cleanPhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function getMetaError(data) {
  return data?.error?.message || "WhatsApp rejected the media message";
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
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

function getMediaType(mimeType = "") {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";

  return "document";
}

function getExtension(mimeType = "", fileName = "") {
  if (fileName.includes(".")) {
    return fileName.split(".").pop().toLowerCase();
  }

  return mimeType.split("/")[1]?.split(";")[0] || "bin";
}

function buildMetaPayload(type, mediaId, caption, fileName) {
  if (type === "image") {
    return {
      type: "image",
      image: {
        id: mediaId,
        caption: caption || "",
      },
    };
  }

  if (type === "video") {
    return {
      type: "video",
      video: {
        id: mediaId,
        caption: caption || "",
      },
    };
  }

  if (type === "audio") {
    return {
      type: "audio",
      audio: {
        id: mediaId,
      },
    };
  }

  return {
    type: "document",
    document: {
      id: mediaId,
      caption: caption || "",
      filename: fileName || "document",
    },
  };
}

function previewForType(type, caption) {
  if (caption) return caption;
  if (type === "image") return "📷 صورة";
  if (type === "video") return "🎥 فيديو";
  if (type === "audio") return "🎤 رسالة صوتية";

  return "📄 مستند";
}

export async function onRequestPost(context) {
  try {
    const supabase = createClient(
      context.env.SUPABASE_URL,
      context.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const body = await context.request.json();
    const { to, message, imageBase64, fileName, mimeType } = body;

    const phone = cleanPhone(to);

    if (!phone || !imageBase64 || !mimeType) {
      return Response.json(
        {
          success: false,
          step: "validation",
          error: "Missing phone, file, or file type",
        },
        {
          status: 400,
        },
      );
    }

    const rawBase64 = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const uploadDataBytes = base64ToUint8Array(rawBase64);
    const mediaType = getMediaType(mimeType);
    const extension = getExtension(mimeType, fileName || "");

    const safeFileName = (fileName || `file.${extension}`).replace(
      /[^a-zA-Z0-9._-]/g,
      "_",
    );

    const storagePath = `outgoing/${Date.now()}-${safeFileName}`;

    let mediaUrl = null;

    const { error: storageError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(storagePath, uploadDataBytes, {
        contentType: mimeType,
        upsert: false,
      });

    if (storageError) {
      console.error("OUTGOING MEDIA STORAGE ERROR:", storageError);
    } else {
      const { data: publicUrlData } = supabase.storage
        .from(MEDIA_BUCKET)
        .getPublicUrl(storagePath);

      mediaUrl = publicUrlData?.publicUrl || null;
    }

    const { phoneNumberId, accessToken } = await getWhatsAppConnection(
      supabase,
      context.env,
    );

    if (!phoneNumberId || !accessToken) {
      throw new Error("No active WhatsApp connection found");
    }

    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append(
      "file",
      new Blob([uploadDataBytes], {
        type: mimeType,
      }),
      safeFileName,
    );

    const uploadResponse = await fetch(
      `https://graph.facebook.com/v25.0/${phoneNumberId}/media`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: formData,
      },
    );

    const uploadResult = await uploadResponse.json();

    if (!uploadResponse.ok) {
      const errorMessage = getMetaError(uploadResult);
      const errorCode = uploadResult?.error?.code || null;

      await supabase.from("messages").insert({
        wa_message_id: null,
        phone,
        direction: "outgoing",
        message_type: "system",
        message: `Media upload failed: ${errorMessage}`,
        status: "failed",
        error_message: errorMessage,
        error_code: errorCode,
      });

      return Response.json(
        {
          success: false,
          step: "upload_media",
          error: errorMessage,
        },
        {
          status: 400,
        },
      );
    }

    const sendResponse = await fetch(
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
          ...buildMetaPayload(
            mediaType,
            uploadResult.id,
            message,
            safeFileName,
          ),
        }),
      },
    );

    const sendResult = await sendResponse.json();

    if (!sendResponse.ok) {
      const errorMessage = getMetaError(sendResult);
      const errorCode = sendResult?.error?.code || null;

      await supabase.from("messages").insert({
        wa_message_id: null,
        phone,
        direction: "outgoing",
        message_type: "system",
        message: `Media send failed: ${errorMessage}`,
        status: "failed",
        error_message: errorMessage,
        error_code: errorCode,
      });

      return Response.json(
        {
          success: false,
          step: "send_media",
          error: errorMessage,
        },
        {
          status: 400,
        },
      );
    }

    await supabase.from("messages").insert({
      wa_message_id: sendResult.messages?.[0]?.id || null,
      phone,
      direction: "outgoing",
      message_type: mediaType,
      message: message || `[${mediaType}]`,
      media_url: mediaUrl,
      status: "accepted",
    });

    await supabase.from("conversations").upsert(
      {
        phone,
        last_message: previewForType(mediaType, message),
        last_message_at: new Date().toISOString(),
      },
      {
        onConflict: "phone",
      },
    );

    return Response.json({
      success: true,
      type: mediaType,
      media_url: mediaUrl,
      data: sendResult,
    });
  } catch (error) {
    console.error("SEND MEDIA ERROR:", error);

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
