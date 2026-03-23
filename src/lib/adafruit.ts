export const AIO_USERNAME = process.env.AIO_USERNAME || "Andre1980";
export const AIO_KEY = process.env.AIO_KEY || "";
export const FEED_KEY = "cartracker2.throttle";

export async function sendAdafruitCommand(command: string) {
  if (!AIO_KEY) {
    throw new Error("AIO_KEY not configured");
  }

  const url = `https://io.adafruit.com/api/v2/${AIO_USERNAME}/feeds/${FEED_KEY}/data`;
  
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-AIO-Key": AIO_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      value: command // e.g. "LOCK" or "UNLOCK"
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Adafruit API Error: ${errorText}`);
  }

  return await res.json();
}
