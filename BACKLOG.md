# Backlog

Bugs y deuda técnica a resolver. Las decisiones de arquitectura viven en [docs/adr/](docs/adr/).

**Estados:** `[ ]` pendiente · `[~]` en curso · `[x]` hecho · `[?]` necesita una decisión antes de empezar

**Severidad:** 🔴 seguridad o pérdida de datos · 🟠 rompe un flujo o deja datos inconsistentes · 🟡 menor

Cada ítem se cierra cuando se cumplen **todos** sus criterios de aceptación y hay un test que fallaba antes del arreglo y pasa después.

Origen: revisión completa del proyecto del 2026-10-29 (lógica git, seguridad y frontend). "Verificado" indica cómo se confirmó el bug.

---

## Tanda 1 — seguridad y pérdida de datos

### B-01 `[x]` 🔴 El token de GitHub se envía a cualquier servidor git

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

- **Dónde:** `public/js/app.js` → `openRepo` y `go()` en `cloneModal`
- **Descripción:** al cambiar de repo se cierra la pestaña File, pero Diff y Conflict quedan abiertas. Sus botones guardan la ruta y el índice del hunk del repo anterior, y el pedido va al repo abierto ahora. "Discard hunk" sobre un diff del repo A borra cambios en B. En Conflict, "Save" escribiría la resolución de A dentro de B.
- **Verificado:** reproducido en el navegador. B perdió `B-CHANGED-MUST-SURVIVE`.
- **Criterios de aceptación:**
  - [x] Abrir o clonar otro repo oculta y vacía las pestañas Diff y Conflict y limpia su estado (archivo de conflicto en curso, etc.).
  - [x] Después de cambiar de repo, ningún botón de la vista anterior queda en el DOM.
  - [x] Test en el navegador con el escenario verificado: B conserva su cambio.
- **Cerrado:** `closeRepoViews()` (File + Diff + Conflict) al abrir y al clonar. Test en Chrome headless (scratchpad `e2e/batch1-ui.mjs`): con el código anterior fallaban 4 comprobaciones de pestañas, con el arreglo pasan las 11. El camino de clonar usa la misma función, pero no se probó en el navegador.

### B-05 `[x]` 🔴 Las operaciones de hunks corrompen archivos sin salto de línea final

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

### B-08 `[ ]` 🟠 Un repo vacío (sin commits) nunca se muestra

- **Dónde:** `public/js/app.js` → `refreshAll`; `server/gitService.js` → `history`
- **Descripción:** `history` falla con `NotFoundError` cuando no hay commits, y eso tumba el `Promise.all` de `refreshAll`. El repo vacío no se dibuja y queda en pantalla el repo anterior, con botones que actúan sobre el vacío.
- **Verificado:** `history` lanza `NotFoundError: Could not find refs/heads/main` en un repo recién creado.
- **Criterios de aceptación:**
  - [ ] Abrir un repo sin commits muestra el repo (nombre, rama), "No commits" en el grafo, y los archivos nuevos en Changes y en el árbol.
  - [ ] El primer commit en ese repo funciona y aparece en el grafo.
  - [ ] Si una parte del refresco falla, el resto de los paneles igual se actualizan, y nunca queda en pantalla otro repo.

### B-09 `[ ]` 🟠 Un symlink dentro del repo escapa de `safePath`

- **Dónde:** `server/state.js` → `safePath`
- **Descripción:** `safePath` compara strings con `path.resolve` sin resolver symlinks. Un repo que trae `link -> ~/.ssh` (isomorphic-git los crea como symlinks reales) permite leer, listar y escribir fuera del repo desde el editor, el árbol y los hunks.
- **Verificado:** las dos revisiones lo reprodujeron: lectura, listado y escritura de un archivo fuera del repo.
- **Criterios de aceptación:**
  - [ ] Leer, escribir, listar o aplicar hunks a través de un symlink que apunta fuera del repo responde 403.
  - [ ] Un symlink que apunta dentro del repo sigue funcionando, o se muestra como link sin seguirlo (decidir al implementar).
  - [ ] Escribir un archivo nuevo debajo de un directorio symlinkeado hacia afuera también se rechaza.
  - [ ] Tests de los tres casos.

### B-10 `[ ]` 🟠 Los atajos de teclado actúan con un modal abierto

- **Dónde:** `public/js/app.js` → listener de `keydown`
- **Descripción:** Ctrl/Cmd+S commitea, y Ctrl/Cmd+Shift+P pushea, aunque haya un modal abierto (Pull mode, Tag, PR, Issue, una confirmación). También pasan cosas raras según el contexto:
  - En la pestaña Conflict, Ctrl+S commitea en lugar de guardar la resolución.
  - Con un archivo binario abierto, Ctrl+S cae en commit.
- **Verificado:** reproducido en el navegador. Se creó un commit con el modal de Pull mode abierto.
- **Criterios de aceptación:**
  - [ ] Con un modal abierto, Ctrl+S, Ctrl+Shift+P y Ctrl+P no hacen nada (o actúan solo dentro del modal).
  - [ ] En la pestaña Conflict, Ctrl+S guarda la resolución.
  - [ ] Con un binario abierto en File, Ctrl+S no commitea.

### B-11 `[ ]` 🟠 Stage de un hunk le saca el bit ejecutable al archivo

- **Dónde:** `server/gitService.js` → `updateIndex` en las operaciones de hunks
- **Descripción:** `updateIndex` se llama sin `mode`, así que queda 100644. Un script `chmod +x` pierde el bit ejecutable en el siguiente commit.
- **Verificado:** reproducido por la revisión (`mode change 100755 => 100644`).
- **Criterios de aceptación:**
  - [ ] Stage y unstage de hunks conservan el modo del archivo (100755 queda 100755).
  - [ ] Test con un archivo ejecutable.

### B-12 `[ ]` 🟠 Un GET sin `Origin` pasa el filtro anti-CSRF

- **Dónde:** `server/index.js` → `isAllowedOrigin`; `server/routes/repo.js` → `/api/repo/sync?fetch=1`
- **Descripción:** los GET cross-site (`<img>`, `<script>`) no mandan `Origin` y el filtro los deja pasar. Una web cualquiera puede disparar GETs con efectos, como `/api/repo/sync?fetch=1`, que hace un fetch de red. No puede leer la respuesta, pero sumado a B-01 eso entregaba el token.
- **Verificado:** leyendo el código. El agente de seguridad lo marcó.
- **Criterios de aceptación:**
  - [ ] Ningún GET tiene efectos: el fetch pasa a `POST`.
  - [ ] Los pedidos a `/api/*` con `Sec-Fetch-Site: cross-site` se rechazan.
  - [ ] Defensa adicional: `/api/*` exige un header propio (por ejemplo `X-GitND: 1`) que una web no puede mandar sin preflight, y la UI lo envía siempre.

### B-13 `[ ]` 🟠 `.git/` se puede leer y escribir desde el editor de archivos

- **Dónde:** `server/state.js` → `safePath`; `server/gitService.js` → `readFile`/`writeFile`
- **Descripción:** el editor puede abrir y guardar `.git/config`, lo que permite cambiar la URL del remote y alimenta B-01.
- **Verificado:** leyendo el código.
- **Criterios de aceptación:**
  - [ ] Leer y escribir rutas dentro de `.git/` desde la API de archivos responde 403.
  - [ ] El árbol de archivos no muestra `.git/`, como hasta ahora.

---

## Tanda 3 — menores

### B-14 `[ ]` 🟡 Los commits rebaseados conservan el committer y la fecha viejos

- **Dónde:** `server/gitService.js` → `rebaseOnto`
- **Descripción:** al re-aplicar commits se pasa solo `author`, así que el committer queda como el autor original con su fecha. Git pone como committer al usuario actual con la fecha actual. Como el grafo ordena por fecha de commit, un commit rebaseado puede quedar dibujado debajo de su padre.
- **Criterios de aceptación:**
  - [ ] Los commits rebaseados mantienen el autor y la fecha de autor, y tienen como committer al usuario actual con la fecha actual.

### B-15 `[ ]` 🟡 Doble click en una carpeta del árbol la deja inconsistente

- **Dónde:** `public/js/tree.js`
- **Descripción:** el colapso corre mientras la expansión todavía está cargando, y después se agregan los hijos igual. Queda ▶ con los hijos visibles, y el siguiente click los duplica. Si una carpeta expandida se borra, la promesa rechaza sin `catch`.
- **Criterios de aceptación:**
  - [ ] Clicks rápidos sobre una carpeta dejan siempre un estado coherente, sin hijos duplicados.
  - [ ] Borrar una carpeta expandida no deja errores sin manejar.

### B-16 `[ ]` 🟡 El WebSocket de otro origen completa el handshake antes de cerrarse

- **Dónde:** `server/index.js`
- **Descripción:** hoy no se filtra nada, porque el socket se cierra antes de registrarse. Es defensa en profundidad.
- **Criterios de aceptación:**
  - [ ] El upgrade se rechaza antes del handshake (`verifyClient`) si el `Origin` o el `Host` no son válidos.

### B-17 `[ ]` 🟡 Un clon fallido deja la carpeta destino vacía

- **Dónde:** `server/gitService.js` → `cloneRepo`
- **Criterios de aceptación:**
  - [ ] Si el clon falla, se borra la carpeta solo si la creó el clon. Nunca se borra una carpeta que ya existía.

### B-18 `[ ]` 🟡 `refreshAll` puede pintar un estado viejo

- **Dónde:** `public/js/app.js` → `refreshAll`
- **Descripción:** solo el grafo tiene guard de época. Un refresco del watcher que salió antes de un commit pero llega después pinta la lista de cambios y las ramas viejas hasta el próximo refresco.
- **Criterios de aceptación:**
  - [ ] Una respuesta de `refreshAll` más vieja que la última aplicada se descarta en todos los paneles.

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
