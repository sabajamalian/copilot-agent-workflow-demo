export function slug(value) {
  if (typeof value !== "string") throw new TypeError("value must be a string");
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}
