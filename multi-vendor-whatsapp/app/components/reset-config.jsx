/**
 * Botón "Configuración recomendada" (acción secundaria de la página) con su
 * diálogo de confirmación. Nada se escribe en Shopify hasta que el
 * comerciante pulse Guardar: la barra aparece y puede revisar o descartar.
 *
 * @param id       id único del modal en la página
 * @param visible  true cuando algo se aleja de lo recomendado
 * @param heading  título del diálogo
 * @param items    qué se va a restablecer (lista de textos)
 * @param onApply  aplica los valores recomendados al estado de la página
 */
/* eslint-disable react/prop-types -- el proyecto es JavaScript y no usa
   prop-types; los props quedan documentados arriba */
export function ResetConfigAction({ id, visible, heading, items, onApply }) {
  return (
    <>
      {visible && (
        <s-button
          slot="secondary-actions"
          icon="reset"
          commandFor={id}
          command="--show"
        >
          Configuración recomendada
        </s-button>
      )}

      <s-modal id={id} heading={heading}>
        <s-stack direction="block" gap="base">
          <s-text>
            Se aplicará la configuración con la que la app funciona mejor para
            la mayoría de tiendas. Tus vendedores y sus números se conservan.
          </s-text>
          <s-unordered-list>
            {items.map((item) => (
              <s-list-item key={item}>{item}</s-list-item>
            ))}
          </s-unordered-list>
          <s-text tone="neutral">
            No se guarda nada hasta que pulses Guardar: podrás revisar el
            resultado o descartarlo.
          </s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor={id}
          command="--hide"
          onClick={onApply}
        >
          Aplicar
        </s-button>
        <s-button slot="secondary-actions" commandFor={id} command="--hide">
          Cancelar
        </s-button>
      </s-modal>
    </>
  );
}
/* eslint-enable react/prop-types */
