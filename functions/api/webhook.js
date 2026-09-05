import { createClient } from "@supabase/supabase-js";

const MEDIA_BUCKET = "whatsapp-media";

function getFriendlyStatusText(status, errorCode, errorMessage) {
  if (status === "read") return "✅ مقروءة";
  if (status === "delivered") return "✅ تم التسليم";
  if (status === "sent") return "✅ تم الإرسال";

  if (status === "failed") {
    if (errorCode === 131047) return "❌ العميل لم يتفاعل / لا يوجد opt-in";
    if (errorCode === 131049) return "❌ واتساب رفض الإرسال لحماية جودة الحساب";
    if (errorCode === 131026) return "❌ الرقم غير قابل للتسليم";

    return `❌ فشل الإرسال: ${errorMessage || "خطأ غير معروف"}`;
  }

  return status || "";
}

function getExtension(mimeType, filename = "") {
  const fromName = filename.split(".").pop()?.toLowerCase();

  if (filename.includes(".") && fromName) {
    return fromName;
  }

  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  };

  return (
    extensions[mimeType] || mimeType?.split("/")[1]?.split(";")[0] || "bin"
  );
}

async function fetchAndStoreMedia(mediaId, originalFilename, supabase, env) {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
    });

    const metaData = await metaRes.json();

    if (!metaRes.ok || !metaData.url) {
      console.error("MEDIA META LOOKUP FAILED:", metaData);
      return null;
    }

    const fileRes = await fetch(metaData.url, {
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
    });

    if (!fileRes.ok) {
      console.error("MEDIA DOWNLOAD FAILED:", fileRes.status);
      return null;
    }

    const fileData = await fileRes.arrayBuffer();

    const mimeType =
      metaData.mime_type ||
      fileRes.headers.get("content-type") ||
      "application/octet-stream";

    const extension = getExtension(mimeType, originalFilename);

    const safeName = originalFilename
      ? originalFilename.replace(/[^\w.-]/g, "_")
      : `${mediaId}.${extension}`;

    const storagePath = `incoming/${Date.now()}-${mediaId}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(storagePath, fileData, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError) {
      console.error("MEDIA UPLOAD ERROR:", uploadError);
      return null;
    }

    const { data: publicUrlData } = supabase.storage
      .from(MEDIA_BUCKET)
      .getPublicUrl(storagePath);

    return publicUrlData?.publicUrl || null;
  } catch (error) {
    console.error("MEDIA STORE ERROR:", error);
    return null;
  }
}

function getMediaObject(message) {
  return (
    message.image ||
    message.audio ||
    message.video ||
    message.document ||
    message.sticker ||
    null
  );
}

function getMessageText(message) {
  return (
    message.text?.body ||
    message.image?.caption ||
    message.document?.caption ||
    message.video?.caption ||
    `[${message.type || "unknown"}]`
  );
}

function getPreviewText(message) {
  if (message.type === "image") {
    return message.image?.caption || "📷 صورة";
  }

  if (message.type === "audio") {
    return "🎤 رسالة صوتية";
  }

  if (message.type === "video") {
    return message.video?.caption || "🎥 فيديو";
  }

  if (message.type === "document") {
    return message.document?.caption || "📄 مستند";
  }

  if (message.type === "sticker") {
    return "🏷️ ملصق";
  }

  return getMessageText(message);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
      return new Response(challenge || "", {
        status: 200,
      });
    }

    return new Response("Forbidden", {
      status: 403,
    });
  }

  if (request.method !== "POST") {
    return Response.json(
      {
        error: "Method not allowed",
      },
      {
        status: 405,
      },
    );
  }

  try {
    const supabase = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const payload = await request.json();
    const entries = payload?.entry || [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        for (const statusItem of value.statuses || []) {
          const waMessageId = statusItem.id;
          const phone = statusItem.recipient_id;
          const status = statusItem.status;
          const errorMessage = statusItem.errors?.[0]?.message || null;
          const errorCode = statusItem.errors?.[0]?.code || null;

          await supabase
            .from("messages")
            .update({
              status,
              error_message: errorMessage,
              error_code: errorCode,
            })
            .eq("wa_message_id", waMessageId);

          if (phone) {
            await supabase.from("conversations").upsert(
              {
                phone,
                last_message: getFriendlyStatusText(
                  status,
                  errorCode,
                  errorMessage,
                ),
                last_message_at: new Date().toISOString(),
              },
              {
                onConflict: "phone",
              },
            );
          }
        }

        for (const message of value.messages || []) {
          const phone = message.from;
          const mediaObj = getMediaObject(message);

          let mediaUrl = null;

          if (mediaObj?.id) {
            mediaUrl = await fetchAndStoreMedia(
              mediaObj.id,
              mediaObj.filename || "",
              supabase,
              env,
            );
          }

          const { error: insertError } = await supabase
            .from("messages")
            .insert({
              wa_message_id: message.id,
              phone,
              direction: "incoming",
              message_type: message.type,
              message: getMessageText(message),
              media_url: mediaUrl,
              status: "received",
            });

          if (insertError && insertError.code !== "23505") {
            console.error("MESSAGE INSERT ERROR:", insertError);
          }

          await supabase.from("conversations").upsert(
            {
              phone,
              last_message: getPreviewText(message),
              last_message_at: new Date().toISOString(),
            },
            {
              onConflict: "phone",
            },
          );

          console.log("INCOMING MESSAGE SAVED:", {
            phone,
            type: message.type,
            hasMedia: Boolean(mediaObj?.id),
            mediaStored: Boolean(mediaUrl),
          });
        }
      }
    }

    return Response.json({
      success: true,
    });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);

    return Response.json(
      {
        success: false,
        error: error.message,
      },
      {
        status: 500,
      },
    );
  }
}
