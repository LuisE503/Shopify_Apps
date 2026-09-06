/**
 * Configuración de React Router.
 *
 * Las banderas `future` adoptan desde ya el comportamiento de la versión 8.
 * Sin ellas el servidor imprime cinco advertencias en cada arranque y, cuando
 * salga esa versión, la actualización traería todos los cambios de golpe.
 *
 * La más útil aquí es `v8_splitRouteModules`: separa el código de servidor del
 * de cliente en cada ruta, así que un módulo `.server` usado por error fuera
 * de `loader`/`action` falla en el momento de compilar y no en el navegador.
 */
export default {
  future: {
    v8_middleware: true,
    v8_splitRouteModules: true,
    v8_viteEnvironmentApi: true,
    v8_passThroughRequests: true,
    v8_trailingSlashAwareDataRequests: true,
  },
};
