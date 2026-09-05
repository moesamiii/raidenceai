import { createClient } from "@supabase/supabase-js";

export async function onRequestGet(context) {
  const supabase = createClient(
    context.env.SUPABASE_URL,
    context.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const url = new URL(context.request.url);
  const phone = url.searchParams.get("phone");

  if (!phone) {
    return Response.json(
      {
        success: false,
        error: "Phone is required",
      },
      {
        status: 400,
      },
    );
  }

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("phone", phone)
    .order("id", { ascending: true });

  if (error) {
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

  return Response.json({
    success: true,
    messages: data,
  });
}
