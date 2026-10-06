import { NativeSelect } from "@chakra-ui/react";

// The usual ones for the region first; any other valid zone already saved is kept as an option
const COMMON: Array<[string, string]> = [
  ["America/Guatemala", "Guatemala"],
  ["America/Mexico_City", "Ciudad de México"],
  ["America/El_Salvador", "El Salvador"],
  ["America/Tegucigalpa", "Honduras"],
  ["America/Managua", "Nicaragua"],
  ["America/Costa_Rica", "Costa Rica"],
  ["America/Panama", "Panamá"],
  ["America/Bogota", "Colombia"],
  ["America/Lima", "Perú"],
  ["America/Guayaquil", "Ecuador"],
  ["America/Caracas", "Venezuela"],
  ["America/Santo_Domingo", "República Dominicana"],
  ["America/Santiago", "Chile"],
  ["America/Argentina/Buenos_Aires", "Argentina"],
  ["America/Sao_Paulo", "Brasil (São Paulo)"],
  ["America/New_York", "EE. UU. Este"],
  ["America/Chicago", "EE. UU. Centro"],
  ["America/Denver", "EE. UU. Montaña"],
  ["America/Los_Angeles", "EE. UU. Pacífico"],
  ["Europe/Madrid", "España"],
  ["UTC", "UTC"],
];

/**
 * Tells a zone's current offset from UTC, as "UTC-6"
 *
 * @param   zone  IANA zone
 *
 * @return  The offset, or nothing if the browser does not know the zone
 */
function offsetOf(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((item) => item.type === "timeZoneName");

    return part ? part.value.replace("GMT", "UTC") : "";
  } catch {
    return "";
  }
}

/**
 * Picks a time zone among the common ones, with an empty choice that inherits another one
 *
 * @param   value      Chosen zone, empty to inherit
 * @param   onChange   Receives the zone, empty to inherit
 * @param   inherited  What the empty choice means, as "la del asistente"
 *
 * @return  The select
 */
export function TimeZoneSelect({
  value,
  onChange,
  inherited,
}: {
  value: string;
  onChange: (zone: string) => void;
  inherited: string;
}) {
  const options: Array<[string, string]> =
    value && !COMMON.some(([zone]) => zone === value) ? [...COMMON, [value, value]] : COMMON;

  return (
    <NativeSelect.Root>
      <NativeSelect.Field value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{`Igual que ${inherited}`}</option>
        {options.map(([zone, label]) => (
          <option key={zone} value={zone}>
            {zone === "UTC" ? label : `${label} (${offsetOf(zone) || zone})`}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}
