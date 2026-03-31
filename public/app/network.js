function errorFromJsonResponse(data) {
  return (data.errors && data.errors.join(" ")) || data.error || "Error inesperado";
}

export async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(errorFromJsonResponse(data));
  }
  return data;
}

export async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(errorFromJsonResponse(data));
  }
  return data;
}

export function scheduleJsonPoll({ delayMs = 700, run }) {
  return setTimeout(async () => {
    await run();
  }, delayMs);
}
