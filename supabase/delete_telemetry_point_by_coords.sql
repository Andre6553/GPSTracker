-- Delete one telemetry point by device + coordinates (preview first).
-- Replace device / lat / lon / speed if needed. Time is optional.

-- 1) Preview
SELECT id, created_at, device_id, lat, lon, speed_kmh, altitude_m, satellites
FROM public.telemetry
WHERE device_id = 'Andre'
  AND lat BETWEEN -34.122219 - 0.00002 AND -34.122219 + 0.00002
  AND lon BETWEEN 22.092565 - 0.00002 AND 22.092565 + 0.00002
  AND speed_kmh = 25
ORDER BY created_at DESC;

-- 2) If exactly one row (or note id from above), delete by id:
-- DELETE FROM public.telemetry WHERE id = '<uuid-from-select>';

-- Or delete all rows matching coords + speed (use only if preview shows the right rows):
-- DELETE FROM public.telemetry
-- WHERE device_id = 'Andre'
--   AND lat BETWEEN -34.122219 - 0.00002 AND -34.122219 + 0.00002
--   AND lon BETWEEN 22.092565 - 0.00002 AND 22.092565 + 0.00002
--   AND speed_kmh = 25;
