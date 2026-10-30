# Backlog

Bugs y deuda técnica a resolver. Las decisiones de arquitectura viven en [docs/adr/](docs/adr/).

**Estados:** `[ ]` pendiente · `[~]` en curso · `[x]` hecho · `[?]` necesita una decisión antes de empezar

**Severidad:** 🔴 seguridad o pérdida de datos · 🟠 rompe un flujo o deja datos inconsistentes · 🟡 menor

Cada ítem se cierra cuando se cumplen **todos** sus criterios de aceptación y hay un test en `test/` que fallaba antes del arreglo, pasa después y corre en CI (`.github/workflows/ci.yml`, en cada push a `main`). Lo que solo se puede ver en el navegador se verifica además con E2E, que se corren a mano.

Origen: revisión completa del proyecto del 2026-10-29 (lógica git, seguridad y frontend). "Verificado" indica cómo se confirmó el bug.

---

## Tanda 1 — seguridad y pérdida de datos

### B-01 `[x]` 🔴 El token de GitHub se envía a cualquier servidor git

- **Re-cerrado (tanda 2b):** `authFor(tokens)` decide con la URL que isomorphic-git le pasa a `onAuth`, o sea la del pedido real, y todas las operaciones de red pasan `corsProxy: null` (con `undefined`, isomorphic-git lee `http.corsProxy` de la config del repo). `test/credentials-redirect.test.js`: con el código anterior fallaban los 2, ahora pasan. La prueba de QA (`b01.mjs`) da OK con `pushurl` y con `corsProxy`. Su único FAIL restante (`github.com\@evil.com`) es un falso positivo: el host real es `github.com`.

- **Reabierto (verificación QA):** la regla de hosts es correcta, pero se decide con `remote.origin.url` mientras isomorphic-git manda el pedido a otro lado. Con `remote.origin.pushurl=http://atacante`, el push le manda el token. Con `http.corsProxy=http://atacante` en la config del repo, el token le llega en el **fetch automático** y en el push. Reproducido (`b01.mjs`, el atacante recibió el token codificado). Arreglo: decidir con la URL que isomorphic-git le pasa a `onAuth`, y rechazar o ignorar `pushurl`/`corsProxy` hacia hosts sin credenciales.

- **Dónde:** `server/gitService.js` → `authFor`
- **Descripción:** para todo host que no contenga "gitlab", `authFor` responde al pedido de credenciales con `tokens.github || tokens.gitlab`, incluso por `http://`. Además, cualquier host que contenga "gitlab" (por ejemplo `gitlab.evil.com`) recibe el token de GitLab. Para robar el token alcanza con que el usuario abra un repo cuyo `origin` apunte a un servidor que responda 401: el fetch automático cada 2 minutos lo entrega sin ningún click. Pegar una URL de clone tiene el mismo efecto.
- **Verificado:** un servidor atacante simulado (que responde 401) recibió `Authorization: Basic …` con el token de prueba completo, tanto por fetch como por clone.
- **Criterios de aceptación:**
  - [x] El token de GitHub se envía solo a `github.com`, por coincidencia exacta del host.
  - [x] El token de GitLab se envía solo al host de `GITLAB_URL` (por defecto `gitlab.com`), por coincidencia exacta.
  - [x] Ningún token se envía por `http://`, salvo al host configurado explícitamente en `GITLAB_URL` con `http://`.
  - [x] Para cualquier otro host, `onAuth` cancela y el error que ve el usuario explica que no hay credenciales para ese host.
  - [x] Tests de la regla de hosts: `github.com.evil.com`, `evil.com/github.com`, `gitlab.evil.com`, `http://github.com`, un host con puerto, y la URL de `GITLAB_URL`.
  - [x] Repetir la prueba con el servidor atacante: no recibe ningún header `Authorization`.
- **Cerrado:** `server/credentials.js`, `test/credentials.test.js`. Con la lógica anterior fallaban los 5 tests; con el arreglo pasan los 5. Prueba de punta a punta: servidor real con un token de GitHub guardado contra el servidor atacante, por fetch y por clone, y el atacante no recibió ningún header `Authorization`.

### B-02 `[x]` 🔴 Merge y Pull (modo merge) borran los cambios sin commitear

- **Dónde:** `server/gitService.js` → `doMerge` (lo usan `mergeBranch` y `pull`)
- **Descripción:** a diferencia de rebase y cherry-pick, el merge no revisa si el árbol de trabajo está limpio. Después de `git.merge` hace `checkout --force`, que pisa todos los cambios locales.
- **Verificado:** se editó `a.txt`, se mergeó una rama que solo tocaba `b.txt`, y el cambio desapareció con `git status` limpio. Pasa con fast-forward y con commit de merge.
- **Criterios de aceptación:**
  - [x] Si hay cambios sin commitear en archivos versionados, merge y pull (modo merge) fallan **antes de tocar nada** con un error claro ("commiteá o stasheá tus cambios").
  - [x] Con el árbol limpio, merge y pull siguen funcionando igual (fast-forward, commit de merge y conflictos).
  - [x] Los archivos untracked no se pierden en ningún caso.
  - [x] Test que repite el escenario verificado y comprueba que el cambio local sigue en disco.
- **Cerrado:** `requireMergeableTree` en `doMerge` (lo usan merge y pull). Un untracked bloquea el merge solo si el merge trae un archivo en esa misma ruta. `test/merge-dirty.test.js`: antes fallaban 3 de 5 tests, ahora pasan los 5. Los conflictos con el árbol limpio están cubiertos por `test/merge-persist.test.js`.

### B-03 `[x]` 🔴 Discard en "Unstaged" borra también lo que está staged

- **Re-cerrado (tanda 2b):** junto con B-19. El escenario de QA está en `test/cache-coherence.test.js`.

- **Reabierto (verificación QA):** la lógica es correcta (binario, CRLF y renombres funcionan), pero a través de la cache vieja de B-19 un discard escribió una versión que el usuario ya había sacado del stage. Se cierra junto con B-19.

- **Dónde:** `server/gitService.js` → `discard`
- **Descripción:** restaura el archivo desde HEAD con `force`, en lugar de hacerlo desde el índice. Se pierde también el cambio staged, y si el archivo era nuevo y estaba staged, se borra del disco y del índice.
- **Verificado:** con un cambio staged (`STAGED`) más uno unstaged (`UNSTAGED`), después del discard el índice y el disco quedaron como HEAD.
- **Criterios de aceptación:**
  - [x] Discard de un archivo con cambios staged y unstaged deja el contenido staged, igual que `git checkout -- <archivo>` / `git restore`.
  - [x] Discard de un archivo nuevo y staged, con cambios encima, vuelve a la versión staged sin borrar el archivo ni sacarlo del índice.
  - [x] Discard de un archivo untracked lo borra, como hasta ahora.
  - [x] Un archivo sin cambios staged vuelve a HEAD, como hasta ahora.
  - [x] Tests de los cuatro casos, comparados contra el resultado de `git restore` en el mismo repo.
- **Cerrado:** `discard` restaura desde el índice y respeta el modo (ejecutable, symlink). `test/discard.test.js` compara cada caso contra `git restore` en un repo gemelo, más un quinto caso con bit ejecutable: antes fallaban 2 de 5, ahora pasan los 5.

### B-04 `[x]` 🔴 Al cambiar de repo, Diff y Conflict quedan vivos y actúan sobre el repo nuevo

- **Re-cerrado (tanda 2b):** la UI escucha `repo-opened`, y `refreshAll` cierra las vistas cuando `info.dir` cambia desde afuera. Si había cambios sin guardar en File, avisa que se descartaron. Un flag (`switchingRepo`) evita ese aviso cuando el cambio lo hizo la propia pestaña. E2E de QA con dos clientes (`b04-twoclients-ui.mjs`): con el código anterior B perdía su cambio, ahora pasa todo. **E2E en el repo:** `e2e/repo-switch.spec.js` (cambio desde esta pestaña y desde otro cliente).

- **Reabierto (verificación QA):** si el cambio de repo lo hace **otro cliente** (otra pestaña, `curl`, un script), la pestaña 1 refresca y muestra B, pero el Diff de A sigue abierto, y "Discard" borró el cambio de B. Reproducido en el navegador (`b04-twoclients-ui.mjs`). Causa: la UI no escucha `repo-opened` y `refreshAll` no cierra las vistas cuando cambia `info.dir`.

- **Dónde:** `public/js/app.js` → `openRepo` y `go()` en `cloneModal`
- **Descripción:** al cambiar de repo se cierra la pestaña File, pero Diff y Conflict quedan abiertas. Sus botones guardan la ruta y el índice del hunk del repo anterior, y el pedido va al repo abierto ahora. "Discard hunk" sobre un diff del repo A borra cambios en B. En Conflict, "Save" escribiría la resolución de A dentro de B.
- **Verificado:** reproducido en el navegador. B perdió `B-CHANGED-MUST-SURVIVE`.
- **Criterios de aceptación:**
  - [x] Abrir o clonar otro repo oculta y vacía las pestañas Diff y Conflict y limpia su estado (archivo de conflicto en curso, etc.).
  - [x] Después de cambiar de repo, ningún botón de la vista anterior queda en el DOM.
  - [x] Test en el navegador con el escenario verificado: B conserva su cambio.
- **Cerrado:** `closeRepoViews()` (File + Diff + Conflict) al abrir y al clonar. Test en Chrome headless (scratchpad `e2e/batch1-ui.mjs`): con el código anterior fallaban 4 comprobaciones de pestañas, con el arreglo pasan las 11. El camino de clonar usa la misma función, pero no se probó en el navegador.

### B-05 `[x]` 🔴 Las operaciones de hunks corrompen archivos sin salto de línea final

- **Re-cerrado (tanda 2b):** los tres casos quedan resueltos.
  1. La marca de jsdiff se respeta solo si el texto del que viene la línea `+` realmente termina sin salto (jsdiff la emite también cuando el otro lado está vacío).
  2. Los blobs se decodifican con `TextDecoder('utf-8', { ignoreBOM: true })`.
  3. Si se hace unstage de todos los hunks de un archivo nuevo, se saca la entrada del índice.

  En `test/hunks.test.js`, los 3 casos nuevos fallaban con el código anterior y ahora pasan. Los FAIL de "stage-all (crlf/bom)" en `merge-hunks.mjs` de QA son un artefacto de su script: compara contra la salida de git con `.trim()`, que también borra el `\r` final y el BOM.

- **Reabierto (verificación QA):** quedan tres casos borde, todos reproducidos:
  1. Discard del hunk de un archivo **borrado** lo restaura sin el salto final.
  2. Un archivo con **BOM UTF-8**: `TextDecoder` le saca el BOM, aparece un hunk fantasma en la línea 1, y el stage/discard borra el BOM.
  3. Unstage de todos los hunks de un archivo **nuevo** deja un blob vacío en el índice; `git restore --staged` saca la entrada.

- **Dónde:** `server/gitService.js` → `applyHunks` y `hunkRows`
- **Descripción:** `jsdiff` emite la marca `\ No newline at end of file`, y el código la trata como una línea de contexto. Stage, unstage y discard de un hunk escriben el texto literal `No newline at end of file` adentro del archivo. La vista de hunks también muestra la marca como si fuera una línea más.
- **Verificado:** `x1\nx2\nx3` sin salto final, editado a `…\nx4`, después del stage del hunk dejó en el índice `x1\nx2\n No newline at end of file\nx3\nx4\n No newline at end of file`.
- **Criterios de aceptación:**
  - [x] Stage, unstage y discard de un hunk producen exactamente el mismo contenido que `git apply` del mismo hunk, con y sin salto de línea final.
  - [x] Se respeta si el archivo termina o no en salto de línea, incluso cuando el hunk agrega o saca ese salto final.
  - [x] La vista de hunks no muestra la marca como línea del archivo; si se indica, se indica aparte.
  - [x] Tests de: agregar línea a un archivo sin salto final, sacar el salto final, agregarlo, y un archivo normal (regresión).
- **Cerrado:** `applyHunks` trabaja con líneas que conservan su terminador, y la marca le saca el `\n` a la línea anterior. `test/hunks.test.js`: aplicar todos los hunks tiene que dar lo mismo que `git add` / `git restore` / `git restore --staged`, en 6 casos más uno de selección parcial. Antes fallaban 13 de 20, ahora pasan los 20.

### B-06 `[x]` 🔴 El merge en curso se pierde al reabrir el repo o reiniciar el servidor

- **Re-cerrado (tanda 2b):** todas las funciones que consultan el estado del merge vuelven a leer `.git/MERGE_HEAD` antes de decidir. Son 13: info, status, stage, commit, amend, cambio de rama, pull, merge, cherry-pick/revert, detalle, resolución, completar y abortar. Así, Abort sobre un merge que ya terminó responde "No merge in progress" y no hace el checkout forzado. Test nuevo en `test/merge-persist.test.js`: con el código anterior falla, ahora pasa.

- **Reabierto (verificación QA):** si el merge se termina desde la **terminal** (`git commit` borra `MERGE_HEAD`), la app sigue con el merge en memoria: banner, commit rechazado, cambio de rama bloqueado. Si después se aprieta **Abort**, el checkout forzado **destruye trabajo nuevo sin commitear**. Reproducido (`recheck.mjs`). Arreglo: tomar `.git/MERGE_HEAD` como única fuente de verdad (releerlo antes de cada operación de merge), no la copia en memoria.

- **Dónde:** `server/state.js` (`open` resetea `merge`) y `server/gitService.js` (merge y commit)
- **Descripción:** el estado del merge con conflictos vive solo en memoria. Si se reabre el repo o se reinicia el servidor, la marca de conflicto desaparece y el siguiente commit queda como un commit normal, con un solo padre y con los marcadores `<<<<<<<` adentro.
- **Verificado:** reproducido por la revisión (`git cat-file -p HEAD` mostró un solo padre y `grep '<<<<'` encontró la marca).
- **Decisión:** se guarda en disco con el mismo formato que usa git (`.git/MERGE_HEAD`, `.git/MERGE_MSG`), así sobrevive a un reinicio y `git commit` desde la terminal también lo reconoce como merge.
- **Criterios de aceptación:**
  - [x] Un merge que se detiene por conflictos escribe `.git/MERGE_HEAD` (oid de la rama entrante) y `.git/MERGE_MSG`.
  - [x] Al abrir un repo con `.git/MERGE_HEAD`, la app restaura el merge en curso: banner, archivos en conflicto y resueltos.
  - [x] Completar el merge crea un commit con dos padres y borra `MERGE_HEAD`/`MERGE_MSG`. Abortarlo también los borra.
  - [x] Un merge iniciado con el git CLI (que deja `MERGE_HEAD`) se muestra como merge en curso.
  - [x] Con un merge en curso, el commit común se rechaza (como hasta ahora) también después de reiniciar el servidor.
  - [x] Test: conflicto → reiniciar el estado → reabrir → resolver → completar → HEAD tiene dos padres y no contiene marcadores.
- **Cerrado:** `writeMergeState` / `loadMergeState` / `clearMergeState` en `gitService.js`. `openRepo` restaura el merge. "Resuelto" se deduce del índice: staged, igual al archivo en disco y sin marcadores. `resetToCommit` también termina el merge. `test/merge-persist.test.js`: antes fallaban los 5, ahora pasan los 5, incluido un merge iniciado con el git CLI.

### B-07 `[x]` 🔴 Después de abortar un merge, la pestaña Conflict sigue abierta y "Save" deshace en parte el abort

- **Dónde:** `public/js/app.js` → `renderMergeBanner` y el editor de conflictos
- **Descripción:** al terminar o abortar un merge, solo se sale de la pestaña Merge. La pestaña Conflict queda abierta, sin botón de cierre, y con el archivo cargado. "Save & mark resolved" escribe y stagea la resolución sin que haya merge en curso.
- **Verificado:** reproducido en el navegador. `f.txt` quedó staged con la versión entrante y sin merge en curso.
- **Criterios de aceptación:**
  - [x] Cuando no hay merge en curso (abortado, completado o el repo cambió), la pestaña Conflict se oculta y su estado se limpia.
  - [x] "Save & mark resolved" se rechaza en el servidor si no hay merge en curso.
  - [x] Test en el navegador con el escenario verificado: después del abort, el árbol queda limpio.
- **Cerrado:** `closeConflict()` desde `renderMergeBanner` y al cambiar de repo. Endpoint nuevo `POST /api/repo/conflict/resolve`, que rechaza la resolución si no hay merge en curso, si el archivo no está en conflicto o si quedan marcadores (`test/resolve-conflict.test.js`, 4 tests). El test del navegador es el mismo que el de B-04. El endpoint es nuevo, así que su test no tiene corrida en rojo.

---

## Tanda 2 — flujos rotos y endurecimiento

### B-08 `[x]` 🟠 Un repo vacío (sin commits) nunca se muestra

- **Cerrado (tanda 2b):** el criterio 3 se completó con B-21. E2E de QA (`b08-ui.mjs`): un panel que falla (índice corrupto, o sync contra un objeto inexistente) deja actualizados los demás y no muestra nada del repo anterior. Con el código anterior fallaban 8 comprobaciones, ahora pasan las 13.

- **Dónde:** `public/js/app.js` → `refreshAll`; `server/gitService.js` → `history`
- **Descripción:** `history` falla con `NotFoundError` cuando no hay commits, y eso tumba el `Promise.all` de `refreshAll`. El repo vacío no se dibuja y queda en pantalla el repo anterior, con botones que actúan sobre el vacío.
- **Verificado:** `history` lanza `NotFoundError: Could not find refs/heads/main` en un repo recién creado.
- **Criterios de aceptación:**
  - [x] Abrir un repo sin commits muestra el repo (nombre, rama), "No commits" en el grafo, y los archivos nuevos en Changes y en el árbol.
  - [x] El primer commit en ese repo funciona y aparece en el grafo.
  - [ ] Si una parte del refresco falla, el resto de los paneles igual se actualizan, y nunca queda en pantalla otro repo. *(Implementado con `Promise.allSettled` y paneles vacíos en caso de falla; falta un test que fuerce la falla de un panel.)*
- **Hallazgo al implementar:** el **primer commit** de un repo nuevo también fallaba ("Nothing staged"). Mientras `.git/index` no existe, isomorphic-git guarda en la cache "índice vacío" y nunca detecta cuando aparece. Era una regresión de la cache por repo del ADR-0001. Arreglo: `repoState.gitCache()` devuelve una cache descartable mientras no exista el índice.
- **Avance:** `history` devuelve `[]` sin commits; `refreshAll` usa `allSettled`. `test/empty-repo.test.js`: con el código anterior falla, ahora pasa. En Chrome (scratchpad `e2e/batch2-ui.mjs`), 5 comprobaciones de B-08: con el código anterior fallaban 4, ahora pasan las 5.

### B-09 `[x]` 🟠 Un symlink dentro del repo escapa de `safePath`

- **Dónde:** `server/state.js` → `safePath`
- **Descripción:** `safePath` compara strings con `path.resolve` sin resolver symlinks. Un repo que trae `link -> ~/.ssh` (isomorphic-git los crea como symlinks reales) permite leer, listar y escribir fuera del repo desde el editor, el árbol y los hunks.
- **Verificado:** las dos revisiones lo reprodujeron: lectura, listado y escritura de un archivo fuera del repo.
- **Criterios de aceptación:**
  - [x] Leer, escribir, listar o aplicar hunks a través de un symlink que apunta fuera del repo responde 403.
  - [x] Un symlink que apunta dentro del repo sigue funcionando, o se muestra como link sin seguirlo (decidir al implementar).
  - [x] Escribir un archivo nuevo debajo de un directorio symlinkeado hacia afuera también se rechaza.
  - [x] Tests de los tres casos.
- **Cerrado:**
  - **Toda ruta:** `safePath` exige que el directorio padre real quede dentro del repo.
  - **Con `follow: true`** (leer, escribir, listar, diff y hunks) también resuelve el último componente. Un symlink hacia afuera o colgante se rechaza.
  - **Decisión:** un link hacia adentro funciona. Stage y discard operan sobre el link sin seguirlo, como git, que versiona el link y no su destino.
  - `test/paths.test.js`: antes fallaban 4 de 6, ahora pasan los 6.

### B-10 `[x]` 🟠 Los atajos de teclado actúan con un modal abierto

- **Dónde:** `public/js/app.js` → listener de `keydown`
- **Descripción:** Ctrl/Cmd+S commitea, y Ctrl/Cmd+Shift+P pushea, aunque haya un modal abierto (Pull mode, Tag, PR, Issue, una confirmación). También pasan cosas raras según el contexto:
  - En la pestaña Conflict, Ctrl+S commitea en lugar de guardar la resolución.
  - Con un archivo binario abierto, Ctrl+S cae en commit.
- **Verificado:** reproducido en el navegador. Se creó un commit con el modal de Pull mode abierto.
- **Criterios de aceptación:**
  - [x] Con un modal abierto, Ctrl+S, Ctrl+Shift+P y Ctrl+P no hacen nada (o actúan solo dentro del modal).
  - [x] En la pestaña Conflict, Ctrl+S guarda la resolución.
  - [x] Con un binario abierto en File, Ctrl+S no commitea.
- **Cerrado:** el listener ignora los atajos con el modal abierto. Ctrl+S depende de la pestaña: File guarda (nada si es binario), Conflict guarda la resolución y en el resto commitea. También se cancela el diálogo de Guardar/Imprimir del navegador. En Chrome (`e2e/batch2-ui.mjs`), con el código anterior fallaban 3 comprobaciones y ahora pasan las 5. Ctrl+Shift+P y Ctrl+P con el modal abierto quedaron verificados solo leyendo el código.

### B-11 `[x]` 🟠 Stage de un hunk le saca el bit ejecutable al archivo

- **Dónde:** `server/gitService.js` → `updateIndex` en las operaciones de hunks
- **Descripción:** `updateIndex` se llama sin `mode`, así que queda 100644. Un script `chmod +x` pierde el bit ejecutable en el siguiente commit.
- **Verificado:** reproducido por la revisión (`mode change 100755 => 100644`).
- **Criterios de aceptación:**
  - [x] Stage y unstage de hunks conservan el modo del archivo (100755 queda 100755).
  - [x] Test con un archivo ejecutable.
- **Cerrado:** `writeIndex` usa el modo de la entrada del índice, como `git apply --cached`, y para un archivo nuevo el bit ejecutable del disco. `test/hunk-mode.test.js`: antes fallaban 2 de 3, ahora pasan los 3.

### B-12 `[x]` 🟠 Un GET sin `Origin` pasa el filtro anti-CSRF

- **Re-cerrado (tanda 2b):** el chequeo compara la ruta como la resuelve Express, decodificada y en minúsculas. `/API/`, `/Api/`, `/%61pi/` y `/%41PI/` sin el header ya no responden 200 (test nuevo en `test/http-csrf.test.js`: fallaba, ahora pasa).

- **Reabierto (verificación QA):** Express no distingue mayúsculas en las rutas, pero el chequeo del header sí. `GET /API/...` y `POST /API/repo/stage` sin `X-GitND` responden 200. Verificado de nuevo: `/API/auth/status` y `/Api/auth/status` sin header devuelven 200.

- **Dónde:** `server/index.js` → `isAllowedOrigin`; `server/routes/repo.js` → `/api/repo/sync?fetch=1`
- **Descripción:** los GET cross-site (`<img>`, `<script>`) no mandan `Origin` y el filtro los deja pasar. Una web cualquiera puede disparar GETs con efectos, como `/api/repo/sync?fetch=1`, que hace un fetch de red. No puede leer la respuesta, pero sumado a B-01 eso entregaba el token.
- **Verificado:** leyendo el código. El agente de seguridad lo marcó.
- **Criterios de aceptación:**
  - [x] Ningún GET tiene efectos: el fetch pasa a `POST`.
  - [x] Los pedidos a `/api/*` con `Sec-Fetch-Site: cross-site` se rechazan.
  - [x] Defensa adicional: `/api/*` exige un header propio (por ejemplo `X-GitND: 1`) que una web no puede mandar sin preflight, y la UI lo envía siempre.
- **Cerrado:**
  - El fetch pasa a `POST /api/repo/sync/fetch`, y `GET /api/repo/sync` ya no hace fetch nunca.
  - Se rechaza `Sec-Fetch-Site` con un valor distinto de `same-origin`/`none`, lo que incluye `same-site`: otro puerto de localhost.
  - `X-GitND: 1` es obligatorio en `/api/*`. Las rutas `/auth/*` y la página quedan afuera, porque son navegaciones.
  - `test/http-csrf.test.js` levanta el servidor real: antes fallaban 3 de 5, ahora pasan los 5.
  - **Cambio de comportamiento:** los scripts y `curl` contra la API ahora tienen que mandar `-H 'X-GitND: 1'`.

### B-13 `[x]` 🟠 `.git/` se puede leer y escribir desde el editor de archivos

- **Re-cerrado (tanda 2b):** ningún componente de la ruta puede ser `.git`, con lo que también quedan cubiertos los repos anidados. La regla se aplica además sobre la **ruta real**: el directorio padre resuelto y, con `follow`, el destino del link. Test nuevo en `test/paths.test.js`: fallaba, ahora pasa. La prueba de QA (`paths.mjs`) da 28 de 29 OK. El que falta recibe un 400 ("los symlinks no tienen hunks", por B-20) en lugar del 403 que esperaba, y el resultado es el mismo: `.git/config` queda intacto.

- **Reabierto (verificación QA):** un symlink **dentro** del repo que apunta a `.git` pasa el chequeo, que es léxico sobre el primer componente y no sobre la ruta real. Con `cfg -> .git/config` y `gdir -> .git` se pudo leer, escribir, listar, ver el diff y hacer discard de hunks sobre `.git/config` y `.git/hooks/pre-commit`; un discard de hunk **vació** `.git/config`. El `.git` de un repo anidado (`nested/.git/config`) también queda expuesto. Reproducido (`paths.mjs`).

- **Dónde:** `server/state.js` → `safePath`; `server/gitService.js` → `readFile`/`writeFile`
- **Descripción:** el editor puede abrir y guardar `.git/config`, lo que permite cambiar la URL del remote y alimenta B-01.
- **Verificado:** leyendo el código.
- **Criterios de aceptación:**
  - [x] Leer y escribir rutas dentro de `.git/` desde la API de archivos responde 403.
  - [x] El árbol de archivos no muestra `.git/`, como hasta ahora.
- **Cerrado:** `safePath` rechaza cualquier ruta cuyo primer componente sea `.git`, sin distinguir mayúsculas (`.GIT` en macOS) y también después de normalizar (`sub/../.git`). `.gitignore` sigue accesible. Está en `test/paths.test.js`.

---

## Tanda 2b — hallazgos de la verificación

### B-19 `[x]` 🔴 La cache compartida no ve las escrituras de índice de la propia app

- **Dónde:** `server/state.js` (`gitCache`) y las llamadas `git.add` / `git.remove` / `git.resetIndex` / `git.updateIndex` en `server/gitService.js`
- **Descripción:** esas funciones escriben el índice **sin** la cache compartida. isomorphic-git detecta que el índice cambió comparando segundos, inode y tamaño, así que una escritura del mismo tamaño dentro del mismo segundo le pasa inadvertida. Consecuencias deterministas:
  - stage → status → unstage → commit crea un **commit vacío**;
  - un discard escribe una versión vieja que el usuario ya había sacado del stage, y se pierde la edición (por eso B-03 queda parcial).
  Los cambios hechos desde la terminal sí se ven bien (verificado: add, commit, reset, checkout, stash, gc).
- **Verificado:** reproducido (`cache3.mjs`). Con la cache desactivada, o con 1,1 s entre pasos, pasa.
- **Criterios de aceptación:**
  - [x] Toda lectura y escritura del índice de la app usa la misma cache, o la cache se invalida en cada escritura de la app.
  - [x] stage → unstage → commit en el mismo segundo se rechaza ("Nothing staged").
  - [x] El escenario de discard de `cache3.mjs` restaura la versión staged.
  - [x] Test que encadena operaciones sin esperas.
- **Cerrado:** `gitService.js` envuelve isomorphic-git en un `Proxy` que inyecta la cache del repo abierto en **todas** sus llamadas sobre ese repo, lecturas y escrituras. Así una escritura actualiza la copia que lee la llamada siguiente. Las llamadas a otro directorio, por ejemplo el destino de un clon, quedan como están. `test/cache-coherence.test.js`: con el código anterior fallaban los 4, ahora pasan. Las pruebas de cache de QA (`cache`, `cache2`, `cache3`) quedan todas OK, incluidos los cambios hechos desde la terminal y `gc`.
- **Límite que queda:** isomorphic-git detecta cambios por segundos, inode y tamaño. Un cambio **externo** del mismo tamaño dentro del mismo segundo que una lectura de la app podría pasar inadvertido hasta la próxima escritura. En las pruebas de QA no apareció.

### B-20 `[x]` 🟠 Las operaciones de hunks siguen los symlinks y corrompen el link

- **Dónde:** `server/gitService.js` → `hunkTexts` / `applyHunkOp`
- **Descripción:** para un symlink sin cambios aparece un hunk (el contenido del destino comparado con el blob del link), y al stagearlo el blob del link se reemplaza por el contenido del archivo. Afecta también el modo (B-11).
- **Verificado:** reproducido (`mode.mjs`).
- **Criterios de aceptación:**
  - [x] Los symlinks no ofrecen hunks: se tratan como una entrada entera (stage/discard del link).
  - [x] Test con un symlink versionado sin cambios y con el destino cambiado.
- **Cerrado:** `fileHunks` devuelve `{ hunks: [], symlink: true }`, y la vista lo explica. `applyHunkOp` rechaza las operaciones con 400. Los dos chequean si es un link antes de leer cualquier contenido, en el disco y en el índice. `test/hunk-symlink.test.js`: con el código anterior fallaban 2 de 3, ahora pasan los 3.

### B-21 `[x]` 🟠 Tras un panel que falla quedan datos del repo anterior (badges de sync, stash)

- **Dónde:** `public/js/app.js` → `refreshSync`, `refreshStash`
- **Descripción:** completa el criterio pendiente de B-08. Si `/api/repo/sync` falla en el repo nuevo, el badge de push sigue mostrando el "2" del repo anterior: `refreshSync` sale temprano y deja los badges. `refreshStash` hace lo mismo con la lista de stash (esto último verificado solo leyendo).
- **Verificado:** reproducido en el navegador (`b08-ui.mjs`).
- **Criterios de aceptación:**
  - [x] Si sync o stash fallan, sus paneles se vacían; nunca quedan con datos de otro repo.
  - [x] Test E2E que fuerza la falla de un endpoint (por ejemplo con `page.route`).
- **Cerrado:** `refreshSync` y `refreshStash` vacían sus paneles cuando el pedido falla. E2E de QA (`b08-ui.mjs`, que hace fallar el endpoint corrompiendo el repo, no con `page.route`): con el código anterior fallaba, ahora pasa. **E2E en el repo:** `e2e/panels.spec.js`, que ahora fuerza la falla con `page.route` (sin corromper ningún repo).

---

## Tanda 3 — menores

### B-14 `[x]` 🟡 Los commits rebaseados conservan el committer y la fecha viejos

- **Dónde:** `server/gitService.js` → `rebaseOnto`
- **Descripción:** al re-aplicar commits se pasa solo `author`, así que el committer queda como el autor original con su fecha. Git pone como committer al usuario actual con la fecha actual. Como el grafo ordena por fecha de commit, un commit rebaseado puede quedar dibujado debajo de su padre.
- **Criterios de aceptación:**
  - [x] Los commits rebaseados mantienen el autor y la fecha de autor, y tienen como committer al usuario actual con la fecha actual.
- **Cerrado:** `pull` le pasa el usuario actual a `rebaseOnto` (exportada para poder testearla sin red), que lo usa como committer con `timestamp` actual. Hay que pasarlo explícito: si falta, isomorphic-git copia el del autor. `test/rebase-committer.test.js`: con el código anterior falla, ahora pasa.

### B-15 `[x]` 🟡 Doble click en una carpeta del árbol la deja inconsistente

- **Dónde:** `public/js/tree.js`
- **Descripción:** el colapso corre mientras la expansión todavía está cargando, y después se agregan los hijos igual. Queda ▶ con los hijos visibles, y el siguiente click los duplica. Si una carpeta expandida se borra, la promesa rechaza sin `catch`.
- **Criterios de aceptación:**
  - [x] Clicks rápidos sobre una carpeta dejan siempre un estado coherente, sin hijos duplicados.
  - [x] Borrar una carpeta expandida no deja errores sin manejar.
- **Cerrado:** cada nodo lleva una secuencia, y una carga de hijos que vuelve después de un click más nuevo se descarta. El re-expandido después de un refresco usa el mismo camino: si la carpeta ya no existe, la colapsa en vez de dejar una promesa sin manejar. E2E (scratchpad `e2e/batch3-ui.mjs`, que demora la respuesta por CDP): con el código anterior quedaba `▶` con hijos y después dos juegos de hijos; ahora pasa. **E2E en el repo:** `e2e/races.spec.js` (retiene la carga de la carpeta con `page.route`). El caso "carpeta borrada" sigue verificado solo leyendo el código.

### B-16 `[x]` 🟡 El WebSocket de otro origen completa el handshake antes de cerrarse

- **Dónde:** `server/index.js`
- **Descripción:** hoy no se filtra nada, porque el socket se cierra antes de registrarse. Es defensa en profundidad.
- **Criterios de aceptación:**
  - [x] El upgrade se rechaza antes del handshake (`verifyClient`) si el `Origin` o el `Host` no son válidos.
- **Cerrado:** `verifyClient` responde 403 al upgrade. Test en `test/http-csrf.test.js`: con `Origin` ajeno, `Origin: null` o `Host` ajeno da 403, y el origen de la UI sigue conectando. Con el código anterior el handshake se completaba (`open`).

### B-17 `[x]` 🟡 Un clon fallido deja la carpeta destino vacía

- **Dónde:** `server/gitService.js` → `cloneRepo`
- **Criterios de aceptación:**
  - [x] Si el clon falla, se borra la carpeta solo si la creó el clon. Nunca se borra una carpeta que ya existía.
- **Cerrado:** `fsp.mkdir(…, { recursive: true })` devuelve la primera carpeta que creó, y eso es exactamente lo que se borra, incluidas las carpetas padre nuevas. Si la carpeta ya existía (vacía), se borra solo lo que escribió el clon. `test/clone-cleanup.test.js`: el caso de carpetas nuevas fallaba con el código anterior; los de carpeta existente y carpeta no vacía quedan como regresión.

### B-18 `[x]` 🟡 `refreshAll` puede pintar un estado viejo

- **Dónde:** `public/js/app.js` → `refreshAll`
- **Descripción:** solo el grafo tiene guard de época. Un refresco del watcher que salió antes de un commit pero llega después pinta la lista de cambios y las ramas viejas hasta el próximo refresco.
- **Criterios de aceptación:**
  - [x] Una respuesta de `refreshAll` más vieja que la última aplicada se descarta en todos los paneles.
- **Cerrado:** cada `refreshAll` lleva un número, y la respuesta de uno que fue superado por un refresco más nuevo se descarta entera, incluidos tree, stash y sync. `refreshTree` tiene su propia secuencia, porque también se llama desde otros lugares. E2E (`e2e/batch3-ui.mjs`, que retiene por CDP la respuesta de `status` de un refresco viejo): con el código anterior quedaba `a.txt` como unstaged después del stage; ahora pasa. **E2E en el repo:** `e2e/races.spec.js` (retiene la respuesta de `status` con `page.route`).

---

## Encontrados al pasar los E2E a Playwright

### B-22 `[x]` 🟡 El autofocus diferido de los modales roba el foco del campo donde ya se está escribiendo

- **Dónde:** `public/js/ui.js` → `openModal`
- **Descripción:** `openModal` le daba el foco al primer campo 30 ms después de abrir. Si en ese lapso el usuario (o un test) ya había pasado al segundo campo, el foco volvía al primero en pleno tipeo, y el texto caía en el campo equivocado. En el modal de clonado, la ruta destino terminaba en el campo URL. Afecta a todos los modales.
- **Verificado:** `e2e/clone.spec.js` repetido 12 veces: fallaba 3 de 12, con la ruta en el campo URL. Con el arreglo, 24 de 24.
- **Cerrado:** el autofocus solo actúa si el foco todavía no entró al modal.
- **Corrección (2026-10-30):** en un primer momento atribuí a este bug un cuelgue intermitente de las corridas E2E (5 a 16 minutos al cerrar el worker). **Era falso.** El registro de energía (`pmset -g log`) muestra que todas las corridas colgadas coinciden con suspensiones de la Mac por inactividad, y ninguna de las normales. No es un problema de la app ni de los tests. Si una corrida E2E tarda minutos de más, conviene revisar primero si la máquina se durmió.

---

### B-23 `[x]` 🟠 La lista de Changes no se puede usar con teclado

- **Dónde:** `public/js/app.js` → `renderChanges`; `public/css/style.css` → `.file-list`
- **Descripción:** había tres problemas en cada fila de Changes:
  1. Las acciones (Stage, Unstage, Discard) tenían `display: none` hasta el hover, así que Tab las salteaba.
  2. El nombre del archivo, que abre el diff o el editor de conflictos, era un `<span>` con `onclick` y no se podía enfocar nunca.
  3. Los botones mostraban solo un símbolo (`＋`, `−`, `↺`), sin nombre para lectores de pantalla.

  Lo destapó el E2E, que tenía que hacer hover antes de cada click.
- **Criterios de aceptación:**
  - [x] Con solo teclado: Tab llega al nombre de cada archivo y a sus acciones, y Enter abre el diff, stagea o descarta (con confirmación).
  - [x] Una acción enfocada se ve, aunque el mouse no esté encima.
  - [x] Cada botón tiene un nombre accesible con su archivo ("Stage README.md").
  - [x] Sin cambio visual en reposo ni en hover.
- **Cerrado:**
  - **Nombre del archivo:** pasa a ser un `<button>` con estilo de texto.
  - **Acciones:** en reposo tienen ancho 0 con `overflow: hidden`, en lugar de `display: none`, así que siguen en el orden de Tab. Se expanden con `:hover` o `:focus-within`, y en pantallas táctiles se ven siempre.
  - **Nombres accesibles:** `aria-label` con el archivo en cada botón.
  - **Test:** `e2e/a11y.spec.js` (recorrido solo con teclado). Con el código anterior falla, ahora pasa.
  - **Visual:** comparé capturas antes y después, en reposo y en hover. Una primera versión con `opacity: 0` recortaba de más los nombres largos en reposo; se descartó.
  - **Corrección a un diagnóstico mío:** había dicho que faltaba un estilo de foco visible, pero Chrome ya dibuja su anillo por defecto (no hay `outline: none`). Quedó como test de regresión.

### B-24 `[x]` 🟠 Otros elementos clickeables que solo responden al mouse

- **Dónde:** unos 15 lugares en `public/js/app.js` (con `el('li', { onclick })`), `public/js/tree.js` (filas del árbol) y `public/js/graph.js` (filas del grafo, `<g>` de SVG).
- **Descripción:** mismo problema que B-23. Afecta a:
  - las listas de recientes y de carpetas del Explorer;
  - los repos remotos;
  - el selector de modo de pull;
  - el historial y la lista de commits del merge;
  - los archivos de un commit;
  - el cambio de rama;
  - los PRs e issues;
  - el Quick open;
  - el árbol de archivos;
  - las filas del grafo.

  Ninguno se puede enfocar ni activar con teclado.
- **Arreglo propuesto (toda la clase de una vez):** que el helper `el()` de `public/js/ui.js` haga operable con teclado cualquier elemento no interactivo que reciba `onclick`, con `tabindex="0"`, `role="button"` y Enter/Espacio para activarlo. El árbol y el grafo no usan `el()` y necesitan lo mismo a mano. En el grafo virtualizado hay que cuidar el foco cuando la fila enfocada sale de la franja dibujada.
- **Criterios de aceptación:**
  - [x] Cada elemento de la lista se alcanza con Tab y se activa con Enter.
  - [x] El foco es visible en todos.
  - [x] Un E2E por flujo principal: abrir un repo reciente, ver un commit, cambiar de rama y navegar el árbol.
- **Cerrado:**
  - **`el()`** (`public/js/ui.js`): un elemento no interactivo con `onclick` pasa a tener `tabindex="0"` y `role="button"`, y Enter o Espacio lo activan (con `makeActivatable`). Si el foco está en un control anidado, la tecla no dispara la fila. Esto cubre las 13 listas.
  - **Árbol:** usa el mismo helper y además lleva `aria-expanded` y `aria-label`.
  - **Grafo:** usa *roving tabindex*. Todo el grafo es un solo punto de Tab, ↑/↓ recorren las filas desplazando la lista virtual y Enter abre el commit. La fila con foco nunca se descarta al virtualizar.
  - **Merge:** solo las filas en conflicto son clickeables; antes las auto-mergeadas habrían sido paradas de Tab vacías.
  - **Foco visible:** anillo de acento en `[role="button"]`, y resaltado de la fila en el grafo (Chrome no dibuja el anillo en grupos SVG).
  - **Test:** `e2e/a11y-keyboard.spec.js`, 7 tests. Con el código anterior fallan los 7, ahora pasan.
  - **Regresión:** 5 corridas completas. Las 4 con la máquina despierta pasaron 25/25. La restante coincidió con una suspensión (ver la corrección en B-22).

---

## Revisión visual (UX/UI, 2026-10-30)

Informe del agente de UX/UI, con capturas y mockup en el scratchpad de la sesión. Hallazgos verificados antes de implementar.

### V-A `[x]` 🟠 Contraste insuficiente (WCAG AA)

- **Descripción:** el texto blanco sobre los botones primarios daba 2,82:1 en oscuro. También fallaban:
  - las etiquetas LOCAL e INCOMING (2,68:1);
  - los chips de rama del merge;
  - el rojo como texto en oscuro (4,37:1);
  - el amarillo, el verde y los links en claro;
  - el botón rojo sólido en oscuro (3,41:1);
  - el chip relleno de la rama actual en el grafo;
  - los bordes de inputs (1,3–1,5:1, cuando el mínimo es 3:1).

  Varios de estos no estaban en el informe y aparecieron al medir. Dos valores propuestos por el agente no alcanzaban: el azul fallaba en hover (3,77:1) y los bordes no llegaban a 3:1.
- **Cerrado:**
  - Tokens solo de texto y de relleno sólido en los dos temas: `--accent-solid`, `--danger-solid`, `--red-text`, `--green-text`, `--yellow-text`, `--ours-text`, `--theirs-text`, `--link` y `--border-strong`.
  - Los botones sólidos **oscurecen** en hover, así el contraste sube en lugar de bajar.
  - `test/contrast.test.js` calcula cada par desde `style.css`, en los dos temas y con el hover. Además falla si algún `color:` usa un color de relleno.

### V-C `[x]` 🟠 La acción destructiva era la más visible; varias acciones primarias a la vez

- **Cerrado:**
  - "Abort merge…" y "Hard reset…" usan `.btn-danger-ghost` (con borde, sin relleno), están separados de la acción principal y llevan "…" porque abren una confirmación. Hard reset va primero en el DOM, para que el orden visual coincida con el de Tab.
  - Un primario deshabilitado se ve neutro y explica por qué ("Resolve 1 conflicted file first.", con `aria-describedby`).
  - El banner de merge no es primario, y en la vista de merge es solo una línea de estado.
  - Test: `e2e/visual-hierarchy.spec.js`.

### V-QW `[x]` 🟡 Mejoras rápidas

- **Cerrado:**
  - links con `--link` (el "Connections" del Explorer era ilegible en oscuro);
  - el título del sidebar pasó de "Explorer" a "Files";
  - los nombres de rama largos se cortan con "…" y muestran el nombre completo en `title`;
  - la misma fecha en el historial y en el grafo (solo fecha, con fecha y hora en hover);
  - las etiquetas de los paneles de conflicto pasaron de 10 a 11 px.

### V-B `[ ]` 🟠 Panel de commit (patrón de GitHub Desktop)

- **Propuesta:**
  - primero el mensaje;
  - el autor como una línea con "change";
  - un botón que dice qué hace ("Commit 1 file to main");
  - deshabilitado con motivo cuando no hay nada staged;
  - el grupo de staged tintado;
  - "Stage all" y "Unstage all" escritos en texto.

  Hoy Commit sigue siendo primario y habilitado durante un merge y sin cambios. Esfuerzo M.

### V-D `[ ]` 🟡 Legibilidad del grafo

- **Propuesta:**
  - sin el espacio vacío entre las lanes y el texto;
  - ancho según el contenedor (hoy la fecha se corta incluso a 1440 px);
  - columnas de hash y fecha relativa;
  - fila seleccionada persistente;
  - chips con relleno.

  Mantiene las filas de 28 px, la virtualización, el roving tabindex y los tests. Esfuerzo M.

### V-E `[ ]` 🟠 Por debajo de 980 px no se puede commitear

- **Dónde:** `public/css/style.css`, regla `@media (max-width: 980px) { .rightbar { display: none } }`.
- **Descripción:** Changes, el stage y Commit viven en `.rightbar`, que desaparece por debajo de 980 px. En una laptop chica no se puede commitear. Es un bug funcional, no solo visual.
- **Propuesta:** un panel desplegable que se abre desde un botón en la barra superior (con el badge de cambios), y el sidebar a 200 px. Esfuerzo M.

### B-25 `[?]` 🟡 "Initial commit" aparece dos veces en el historial

- **Origen:** captura del agente de UX/UI. Todavía no está reproducido.

### B-26 `[?]` 🟠 Commits con la misma fecha de commit se dibujan en orden incorrecto

- **Origen:** en la captura del agente, "Tweak f2" aparece debajo de su padre. Sospecha: commits con el mismo `committer.timestamp` al segundo (series rebaseadas o hechas por scripts) desempatan mal en la cola por fecha de `GraphWalk`. El ADR-0001 aceptaba el desorden por clock skew como raro, pero los empates pueden ser frecuentes. Todavía no está reproducido.

---

## Para evaluar (comportamientos raros, no bugs)

- Amend y cherry-pick resetean la fecha del autor. Git la conserva.
- Rebase y cherry-pick ignoran el modo del archivo y los symlinks: un symlink re-aplicado queda como archivo común.
- Rebase conserva como commits vacíos los commits cuyos cambios ya estaban aplicados. Git los descarta.
- Borrar una rama sin mergear no avisa (`git branch -d` sí avisa) y no hay reflog para recuperarla.
- Un archivo untracked bloquea cherry-pick, revert y pull --rebase. Es más estricto que git.
- Cherry-pick de un cambio que ya está en HEAD responde "Conflict" en lugar de "nada para hacer".
- Escape sobre un `confirmModal` deja su promesa sin resolver.
- El botón "Text mode" del editor de conflictos conserva el resaltado del archivo anterior.
- Desde el panel de ramas no se puede mergear una rama local, solo las remotas.
