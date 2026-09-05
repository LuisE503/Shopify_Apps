import {
  MIN_PHONE_DIGITS,
  TIME_OPTIONS,
  WEEK_DAYS,
  WEIGHT_OPTIONS,
  countryHint,
  describeSchedule,
  digitsOnly,
  initialsOf,
  isRowCustomized,
  isRowDirty,
  relativeTime,
  toTags,
  toWeight,
} from "../lib/vendors";

/**
 * Tarjeta de un vendedor.
 *
 * Lo esencial (nombre, número, activo) siempre a la vista; prioridad, horario
 * y etiquetas quedan en "Opciones", que se abre sola si ya hay algo configurado.
 *
 * @param row            fila del estado local (ver makeRows)
 * @param index / count  posición en la lista, para los botones de orden
 * @param errors         errores de esta fila: { name, phone, hours, days }
 * @param previewMessage mensaje de ejemplo para el enlace de prueba
 * @param stats          { count, lastClickAt } de este número, si hay clics
 * @param share          fracción de la rotación que le corresponde (0-1)
 * @param onDuty         true/false si tiene horario, null si no
 * @param onChange       (id, campo, valor) => void
 * @param onMove         (id, -1 | 1) => void
 * @param onReset        (id) => void — vuelve a la configuración recomendada
 * @param onRemove       (id) => void
 */
/* eslint-disable react/prop-types -- el proyecto es JavaScript y no usa
   prop-types en ninguna ruta; los props quedan documentados arriba */
export function VendorRow({
  row,
  index,
  count,
  errors,
  previewMessage,
  stats,
  share,
  onDuty,
  onChange,
  onMove,
  onReset,
  onRemove,
}) {
  const phoneDigits = digitsOnly(row.phone);
  const canTest = !errors.phone && phoneDigits.length >= MIN_PHONE_DIGITS;
  const testUrl = `https://wa.me/${phoneDigits}?text=${encodeURIComponent(previewMessage)}`;
  const sharePercent = Math.round(share * 100);
  const customized = isRowCustomized(row);

  // Resumen de lo configurado cuando las opciones están plegadas
  const rowTags = toTags(row.tags);
  const summary = [
    toWeight(row.weight) !== 1 ? `Prioridad ${toWeight(row.weight)}×` : null,
    row.scheduled ? describeSchedule(row) : null,
    rowTags.length > 0 ? `Solo: ${rowTags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const toggleDay = (day) => {
    const days = row.days.includes(day)
      ? row.days.filter((d) => d !== day)
      : [...row.days, day].sort((a, b) => a - b);
    onChange(row.id, "days", days);
  };

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            label="Nombre"
            placeholder="Ej: María"
            value={row.name}
            {...(errors.name ? { error: errors.name } : {})}
            onInput={(e) => onChange(row.id, "name", e.currentTarget.value)}
          ></s-text-field>
          <s-text-field
            label="Número de WhatsApp"
            placeholder="Ej: 50371234567"
            details={countryHint(row.phone)}
            value={row.phone}
            {...(errors.phone ? { error: errors.phone } : {})}
            onInput={(e) => onChange(row.id, "phone", e.currentTarget.value)}
          ></s-text-field>
        </s-grid>

        <s-stack direction="inline" gap="base" alignItems="center">
          {row.name.trim() && (
            <s-avatar
              initials={initialsOf(row.name)}
              alt={row.name}
              size="small"
            ></s-avatar>
          )}
          <s-switch
            label="Activo"
            checked={row.active}
            onChange={(e) => onChange(row.id, "active", e.currentTarget.checked)}
          ></s-switch>
          {row.active && row.scheduled && onDuty !== null && (
            <s-badge tone={onDuty ? "success" : "auto"}>
              {onDuty ? "En turno ahora" : "Fuera de turno"}
            </s-badge>
          )}
          {!row.expanded && summary && <s-badge tone="info">{summary}</s-badge>}
          {stats && (
            <s-badge tone="info">
              {`${stats.count} clic(s) · ${relativeTime(stats.lastClickAt)}`}
            </s-badge>
          )}
          {isRowDirty(row) && <s-badge tone="warning">Sin guardar</s-badge>}
          <s-button
            variant="tertiary"
            icon={row.expanded ? "chevron-up" : "chevron-down"}
            onClick={() => onChange(row.id, "expanded", !row.expanded)}
          >
            {row.expanded ? "Ocultar opciones" : "Opciones"}
          </s-button>
          {canTest && (
            <s-button variant="tertiary" href={testUrl} target="_blank">
              Probar en WhatsApp
            </s-button>
          )}
          <s-button
            icon="arrow-up"
            variant="tertiary"
            accessibilityLabel="Subir en la lista"
            {...(index === 0 ? { disabled: true } : {})}
            onClick={() => onMove(row.id, -1)}
          ></s-button>
          <s-button
            icon="arrow-down"
            variant="tertiary"
            accessibilityLabel="Bajar en la lista"
            {...(index === count - 1 ? { disabled: true } : {})}
            onClick={() => onMove(row.id, 1)}
          ></s-button>
          <s-button
            icon="delete"
            variant="tertiary"
            tone="critical"
            accessibilityLabel={`Eliminar vendedor ${row.name || "sin nombre"}`}
            onClick={() => onRemove(row.id)}
          ></s-button>
        </s-stack>

        {row.expanded && (
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-grid gridTemplateColumns="1fr 1fr" gap="base" alignItems="end">
                <s-select
                  label="Prioridad"
                  details={
                    row.active && sharePercent > 0
                      ? `≈ ${sharePercent}% de la rotación`
                      : "Turnos por vuelta"
                  }
                  value={String(row.weight)}
                  onChange={(e) =>
                    onChange(row.id, "weight", Number(e.currentTarget.value))
                  }
                >
                  {WEIGHT_OPTIONS.map((weight) => (
                    <s-option key={weight} value={String(weight)}>
                      {weight === 1 ? "1 (normal)" : `${weight}×`}
                    </s-option>
                  ))}
                </s-select>
                <s-switch
                  label="Horario de atención"
                  details="Solo recibe clics en sus días y horas"
                  checked={row.scheduled}
                  onChange={(e) =>
                    onChange(row.id, "scheduled", e.currentTarget.checked)
                  }
                ></s-switch>
              </s-grid>

              {row.scheduled && (
                <s-stack direction="block" gap="base">
                  <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                    <s-select
                      label="Desde"
                      value={row.start}
                      onChange={(e) =>
                        onChange(row.id, "start", e.currentTarget.value)
                      }
                    >
                      {TIME_OPTIONS.map((time) => (
                        <s-option key={time} value={time}>
                          {time}
                        </s-option>
                      ))}
                    </s-select>
                    <s-select
                      label="Hasta"
                      value={row.end}
                      {...(errors.hours ? { error: errors.hours } : {})}
                      onChange={(e) =>
                        onChange(row.id, "end", e.currentTarget.value)
                      }
                    >
                      {TIME_OPTIONS.map((time) => (
                        <s-option key={time} value={time}>
                          {time}
                        </s-option>
                      ))}
                    </s-select>
                  </s-grid>

                  <s-stack direction="inline" gap="base" alignItems="center">
                    {WEEK_DAYS.map((day) => (
                      <s-checkbox
                        key={day.value}
                        label={day.label}
                        checked={row.days.includes(day.value)}
                        onChange={() => toggleDay(day.value)}
                      ></s-checkbox>
                    ))}
                  </s-stack>

                  {errors.days && (
                    <s-text tone="critical">{errors.days}</s-text>
                  )}
                  <s-text tone="neutral">{describeSchedule(row)}</s-text>
                </s-stack>
              )}

              <s-text-field
                label="Solo atiende productos con estas etiquetas"
                placeholder="Ej: electrónica, mayoreo"
                details="Separadas por coma. Vacío = atiende todos los productos. Si un producto lleva la etiqueta de un especialista, solo él recibe ese clic."
                value={row.tags}
                onInput={(e) => onChange(row.id, "tags", e.currentTarget.value)}
              ></s-text-field>

              {customized && (
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant="tertiary"
                    icon="undo"
                    onClick={() => onReset(row.id)}
                  >
                    Restablecer a lo recomendado
                  </s-button>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        )}
      </s-stack>
    </s-box>
  );
}
/* eslint-enable react/prop-types */
