/**
 * Match telegram-alerts owner pick: among user_devices rows for deviceId, prefer a user_id
 * that has a geofence named "home" (case-insensitive). Stable sort by user_id if several qualify.
 */
export async function resolveDeviceContext(supabase, deviceId) {
  const { data: links, error: lErr } = await supabase
    .from("user_devices")
    .select("user_id")
    .eq("device_id", deviceId);
  if (lErr) throw new Error(`user_devices: ${lErr.message}`);
  if (!links?.length) throw new Error(`No user_devices row for device_id=${deviceId}`);

  const ownerCandidates = [...new Set(links.map((r) => r.user_id))];
  const { data: geoNameRows, error: gNameErr } = await supabase
    .from("geofences")
    .select("user_id,name")
    .in("user_id", ownerCandidates);
  if (gNameErr) throw new Error(gNameErr.message);

  const userIdsWithHome = new Set(
    (geoNameRows ?? [])
      .filter((z) => String(z.name ?? "").trim().toLowerCase() === "home")
      .map((z) => z.user_id),
  );

  let pool = links.filter((r) => userIdsWithHome.has(r.user_id));
  if (pool.length === 0) {
    throw new Error(
      `No "Home" geofence for any user_devices owner of "${deviceId}". user_ids: ${ownerCandidates.join(", ")}`,
    );
  }
  pool.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
  const ownerUserId = pool[0].user_id;

  const { data: zones, error: zErr } = await supabase
    .from("geofences")
    .select("id,name,lat,lon,radius_meters")
    .eq("user_id", ownerUserId);
  if (zErr) throw new Error(zErr.message);
  const home = (zones ?? []).find((z) => String(z.name ?? "").trim().toLowerCase() === "home");
  if (!home) throw new Error(`No Home row for owner ${ownerUserId}`);

  return {
    ownerUserId,
    home,
    duplicateDeviceLinks: links.length > 1,
  };
}
