-- 0004：材質 + 光照屬性
-- material_props: 通用材質（每個物件都可調）
--   {color, roughness, metalness, opacity, emissive, emissiveIntensity}
-- led_props: 只 LED panel 用 — 發光體屬性
--   {brightness, saturation, hue, castLightStrength}
ALTER TABLE stage_objects ADD COLUMN material_props TEXT;
ALTER TABLE stage_objects ADD COLUMN led_props TEXT;
