/* eslint-disable react/prop-types -- el proyecto es JavaScript y no usa
   prop-types; cada componente documenta sus props en su comentario */

/**
 * Indicador grande.
 *
 * @param label  qué se mide
 * @param value  número o texto corto
 * @param delta  { percent: number | null, label: string } — variación vs. periodo anterior
 * @param hint   línea pequeña de contexto
 * @param text   true si `value` es texto (se muestra más pequeño)
 */
export function StatTile({ label, value, delta, hint, text = false }) {
  let deltaNode = null;
  if (delta) {
    if (delta.percent === null || delta.percent === undefined) {
      deltaNode = (
        <span className="mvw-tile__delta mvw-tile__delta--flat">
          Sin datos del periodo anterior
        </span>
      );
    } else {
      const direction = delta.percent > 0 ? "up" : delta.percent < 0 ? "down" : "flat";
      const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "•";
      deltaNode = (
        <span className={`mvw-tile__delta mvw-tile__delta--${direction}`}>
          {`${arrow} ${Math.abs(delta.percent)} % ${delta.label}`}
        </span>
      );
    }
  }

  return (
    <div className="mvw-tile">
      <span className="mvw-tile__label">{label}</span>
      <span className={`mvw-tile__value${text ? " mvw-tile__value--text" : ""}`}>
        {value}
      </span>
      {deltaNode}
      {hint && <span className="mvw-tile__hint">{hint}</span>}
    </div>
  );
}

/**
 * Barras verticales de una sola serie.
 *
 * @param items       [{ key, label, count }]
 * @param labelEvery  cada cuántas barras se imprime la etiqueta (evita choques)
 * @param height      alto en px
 * @param ariaLabel   resumen para lectores de pantalla
 * @param unit        palabra tras el número en el tooltip/tabla
 */
export function BarChart({
  items,
  labelEvery = 1,
  height = 96,
  ariaLabel,
  unit = "clic(s)",
}) {
  const max = Math.max(1, ...items.map((item) => item.count));
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="mvw-chart" style={{ "--mvw-chart-height": `${height}px` }}>
      <div className="mvw-chart__plot">
        <div className="mvw-chart__grid" aria-hidden="true">
          <span className="mvw-chart__gridline" style={{ bottom: "75%" }} />
          <span className="mvw-chart__gridline" style={{ bottom: "50%" }} />
          <span className="mvw-chart__gridline" style={{ bottom: "25%" }} />
          <span className="mvw-chart__max">{`máx. ${max}`}</span>
        </div>
        <div
          className="mvw-chart__bars"
          role="img"
          aria-label={ariaLabel ?? `${total} ${unit} en ${items.length} periodos`}
        >
          {items.map((item) => {
            const barHeight =
              item.count > 0 ? Math.max(6, Math.round((item.count / max) * height)) : 2;
            return (
              <div
                key={item.key}
                className="mvw-chart__col"
                data-value={`${item.label}: ${item.count}`}
                title={`${item.label}: ${item.count} ${unit}`}
              >
                <div
                  className={`mvw-chart__bar${item.count === 0 ? " mvw-chart__bar--empty" : ""}`}
                  style={{ height: `${barHeight}px` }}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="mvw-chart__labels" aria-hidden="true">
        {items.map((item, index) => (
          <div key={item.key} className="mvw-chart__label">
            {index % labelEvery === 0 ? item.label : ""}
          </div>
        ))}
      </div>
      <details className="mvw-chart__table">
        <summary>Ver como tabla</summary>
        <table>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                <td>{item.label}</td>
                <td>{item.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/**
 * Reparto entre vendedores: barra con lo recibido y, si se indica, una marca
 * con lo que le correspondería según su prioridad configurada.
 *
 * @param rows   [{ key, name, count, expected }] expected en 0-1 o null
 * @param total  clics totales del periodo (para el porcentaje)
 */
export function ShareList({ rows, total }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const hasExpected = rows.some((row) => row.expected !== null && row.expected !== undefined);

  return (
    <div className="mvw-share">
      {rows.map((row) => {
        const share = total > 0 ? row.count / total : 0;
        const expectedPercent =
          row.expected !== null && row.expected !== undefined
            ? Math.round(row.expected * 100)
            : null;
        return (
          <div key={row.key} className="mvw-share__row">
            <s-text>{row.name}</s-text>
            <span className="mvw-share__meta">
              {`${row.count} · ${Math.round(share * 100)} %`}
              {expectedPercent !== null ? ` (configurado ${expectedPercent} %)` : ""}
            </span>
            <div
              className="mvw-share__track"
              title={
                expectedPercent !== null
                  ? `${row.name}: recibe ${Math.round(share * 100)} %, por prioridad le corresponde ${expectedPercent} %`
                  : `${row.name}: ${row.count}`
              }
            >
              <div
                className="mvw-share__fill"
                style={{ width: `${Math.round((row.count / max) * 100)}%` }}
              />
              {expectedPercent !== null && (
                <span
                  className="mvw-share__expected"
                  style={{ left: `calc(${Math.round(row.expected * 100)}% - 1px)` }}
                />
              )}
            </div>
          </div>
        );
      })}
      {hasExpected && (
        <div className="mvw-legend">
          <span>
            <span className="mvw-legend__swatch" style={{ background: "var(--mvw-bar)" }} />
            Clics recibidos
          </span>
          <span>
            <span
              className="mvw-legend__swatch"
              style={{ background: "var(--mvw-ink)", opacity: 0.55, width: "2px" }}
            />
            Lo que le corresponde por prioridad
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Estado vacío con título y explicación.
 */
export function EmptyState({ title, children }) {
  return (
    <div className="mvw-empty">
      <span className="mvw-empty__title">{title}</span>
      <span>{children}</span>
    </div>
  );
}
