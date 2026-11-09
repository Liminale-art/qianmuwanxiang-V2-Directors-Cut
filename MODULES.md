# 千幕根目录功能地图

> 由 `scripts/generate-module-map.mjs` 生成，勿手改；新增或删除根目录文件后运行 `node scripts/generate-module-map.mjs`。
> 只是导航：文件仍平铺在根目录，分组按文件名前缀推断，“首行说明”取自文件开头注释（无则留空）。“发行”指是否列入 `release-files.json`。

根目录文件 551 个，其中 `qianmu-*` 模块 534 个。

## 入口、宿主与安装

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `LICENSE` | 是 |  |
| `builtin-theaters.js` | 是 | 千幕 (Qianmu) 内置剧场组「吱吱小剧场」 |
| `index.js` | 是 | 千幕 (Qianmu) - SillyTavern third-party UI extension |
| `install-server-plugin.ps1` | 是 |  |
| `install-server-plugin.sh` | 是 |  |
| `install-yimu.ps1` | 否 |  |
| `install-yimu.sh` | 否 |  |
| `manifest.json` | 是 |  |
| `package.json` | 是 |  |
| `release-files.json` | 否 |  |
| `server-plugin.js` | 是 | 千幕 · SillyTavern Server Plugin |
| `style.css` | 是 |  |
| `update-server-plugin.sh` | 否 |  |

## 子目录（已归档的文件）

| 目录 | 跟踪文件数 |
| --- | --- |
| `.claude/` | 1 |
| `assets/focus-sounds/` | 8 |
| `assets/logos/` | 5 |
| `evaluation/` | 2 |
| `features/` | 55 |
| `scripts/` | 158 |
| `server/` | 65 |
| `tests/` | 959 |
| `vendor/noble-hashes-2.4.0/` | 9 |
| `vendor/zip-js-2.24.0/` | 3 |
| `workflows/` | 6 |
| `yimu/` | 52 |

## 文档

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `INSTALL-CANDIDATE.md` | 是 |  |
| `INSTALL-SERVER-PLUGIN.md` | 是 |  |
| `README.md` | 是 |  |
| `THIRD_PARTY_NOTICES.md` | 是 |  |

## 分镜（storyboard）（103）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-director-auto-refresh.js` | 是 | A single, chat-bound pending trigger. This never saves, retries a model call, |
| `qianmu-director-candidate.js` | 是 | 千幕·导演候选池。只对叙事账本条目作确定性评估，不读取正文、媒体、存储或网络。 |
| `qianmu-director-decision.js` | 是 | 千幕·导演决策单。把用户确认后的候选转成下游唯一可消费凭据；不读写存储、媒体或网络。 |
| `qianmu-director-host-state.js` | 是 | Read-only ST lifecycle signals. This is an admission check, not a native-save |
| `qianmu-director-leave-guard.js` | 是 | Narrow UI protection, not a host save lock or a persistence receipt. |
| `qianmu-director-live.js` | 是 |  |
| `qianmu-director-navigation.js` | 是 | Deferred user navigation only. Keep immutable identities, not DOM elements or |
| `qianmu-director-save-confirmation.js` | 是 |  |
| `qianmu-director-work-order.js` | 是 | 千幕·导演工作单。下游工种只接收已批准决策的有限投影，不再解释原始推演文本。 |
| `qianmu-storyboard-bundle-configuration.js` | 是 |  |
| `qianmu-storyboard-bundle-resources.js` | 是 |  |
| `qianmu-storyboard-bundle-restore-runtime.js` | 是 |  |
| `qianmu-storyboard-bundle-restore-worker.js` | 是 |  |
| `qianmu-storyboard-bundle-restore.js` | 是 |  |
| `qianmu-storyboard-bundle-runtime.js` | 是 |  |
| `qianmu-storyboard-bundle-source.js` | 是 |  |
| `qianmu-storyboard-bundle-view.js` | 是 |  |
| `qianmu-storyboard-bundle-worker.js` | 是 |  |
| `qianmu-storyboard-bundle.js` | 是 |  |
| `qianmu-storyboard-capture-view.js` | 是 |  |
| `qianmu-storyboard-chat-evidence.js` | 是 |  |
| `qianmu-storyboard-compiler-diagnostics.js` | 是 | Safe summaries for preparation/stale-input exits use the existing log store. |
| `qianmu-storyboard-compiler-result.js` | 是 | Lazy compiler-result adapter. It owns no host state, event subscriptions or |
| `qianmu-storyboard-compiler-sources.js` | 是 |  |
| `qianmu-storyboard-compiler-transport.js` | 是 | Chosen-API adapter; diagnostics travel through existing response callbacks. |
| `qianmu-storyboard-complete-context.js` | 是 | Complete user-selected context goes only to the configured extraction API. |
| `qianmu-storyboard-connection-identity.js` | 是 |  |
| `qianmu-storyboard-continuation-host.js` | 是 | Observe only an explicit host continue. No polling, raw-token interpretation, |
| `qianmu-storyboard-continuation-proof.js` | 是 |  |
| `qianmu-storyboard-continuation.js` | 是 | Only an observed host "continue" may bridge reply generations. No text-only |
| `qianmu-storyboard-continuity-events.js` | 是 |  |
| `qianmu-storyboard-continuity-link.js` | 是 |  |
| `qianmu-storyboard-continuity-source.js` | 是 |  |
| `qianmu-storyboard-continuity-store.js` | 是 |  |
| `qianmu-storyboard-contract.js` | 是 |  |
| `qianmu-storyboard-delivery-drain.js` | 是 | Receive only the selected ST account's pending pictures into its current chat. |
| `qianmu-storyboard-environment-map.js` | 是 |  |
| `qianmu-storyboard-export-scope-view.js` | 是 |  |
| `qianmu-storyboard-export-scope.js` | 是 |  |
| `qianmu-storyboard-floor-capture.js` | 是 |  |
| `qianmu-storyboard-floor-take-receipt.js` | 是 | Compact chat metadata, independent of deletable gallery images. These receipts |
| `qianmu-storyboard-floor-take-scope.js` | 是 |  |
| `qianmu-storyboard-floor-take-source.js` | 是 |  |
| `qianmu-storyboard-floor-take.js` | 是 | A floor retake is an immutable receipt attached to the original jobs/images. |
| `qianmu-storyboard-focused-extraction.js` | 是 |  |
| `qianmu-storyboard-focused-input.js` | 是 | Compact representation, not summarization: every character of each selected |
| `qianmu-storyboard-inline-reading.js` | 是 | The reading surface has one vertical slot per narrative shot. Only versions |
| `qianmu-storyboard-legacy-vibes.js` | 是 |  |
| `qianmu-storyboard-limits.js` | 是 | Per-floor narrative shots are independent of provider variants and concurrency. |
| `qianmu-storyboard-link-review-view.js` | 是 |  |
| `qianmu-storyboard-link-review.js` | 是 |  |
| `qianmu-storyboard-mapping-contract.js` | 是 | Compact metadata only. Full receipts are verified and serialized in a short-lived Worker. |
| `qianmu-storyboard-mapping-registry.js` | 是 |  |
| `qianmu-storyboard-mapping-view.js` | 是 |  |
| `qianmu-storyboard-nav-lifecycle.js` | 是 | Preserve only the optional glass navigation, never page content or renderer-owned state. |
| `qianmu-storyboard-ordinary-continuation.js` | 是 | Old ordinary jobs retain their original revision and budget. A saved v2 |
| `qianmu-storyboard-ordinary-moment.js` | 是 |  |
| `qianmu-storyboard-original-recovery.js` | 是 | Bounded recovery of known original tasks. This coordinator has no submission, |
| `qianmu-storyboard-package-assets.js` | 是 |  |
| `qianmu-storyboard-package-draft.js` | 是 |  |
| `qianmu-storyboard-package-fields.js` | 是 |  |
| `qianmu-storyboard-package-history.js` | 是 |  |
| `qianmu-storyboard-package-input.js` | 是 |  |
| `qianmu-storyboard-package-journal.js` | 是 |  |
| `qianmu-storyboard-package-mutation.js` | 是 |  |
| `qianmu-storyboard-package-presets.js` | 是 |  |
| `qianmu-storyboard-package-relations.js` | 是 |  |
| `qianmu-storyboard-package-runtime.js` | 是 |  |
| `qianmu-storyboard-package-security.js` | 是 |  |
| `qianmu-storyboard-package-stage.js` | 是 |  |
| `qianmu-storyboard-package-worker.js` | 是 |  |
| `qianmu-storyboard-persona-world.js` | 是 | Binding metadata only. No host imports, worldbook reads, persistence or activation scan. |
| `qianmu-storyboard-preparation-guard.js` | 是 | Preparation input ownership only: no storage, model or startup side effects. |
| `qianmu-storyboard-queue-batch.js` | 是 | A prepared batch owns its jobs and takes only one queue permit at a time. |
| `qianmu-storyboard-queue-window.js` | 是 | Only the jobs already accepted by the ordinary queue occupy its eight slots. |
| `qianmu-storyboard-resource-origins.js` | 是 |  |
| `qianmu-storyboard-restore-storage-runtime.js` | 是 |  |
| `qianmu-storyboard-restore-storage-view.js` | 是 |  |
| `qianmu-storyboard-restore-storage-worker.js` | 是 |  |
| `qianmu-storyboard-restore-storage.js` | 是 |  |
| `qianmu-storyboard-result-inbox.js` | 是 | Only accepted original-image bytes cross an ST account switch. Recipes and |
| `qianmu-storyboard-source-proof.js` | 是 | Shared source primitives. Kept separate so ordinary and streaming source |
| `qianmu-storyboard-stream-attempt.js` | 是 |  |
| `qianmu-storyboard-stream-checkpoint-storage.js` | 是 |  |
| `qianmu-storyboard-stream-coverage.js` | 是 |  |
| `qianmu-storyboard-stream-final-storage.js` | 是 |  |
| `qianmu-storyboard-stream-final.js` | 是 |  |
| `qianmu-storyboard-stream-host.js` | 是 |  |
| `qianmu-storyboard-stream-jobs.js` | 是 | Consume one live compiler handoff without borrowing the editable workbench. |
| `qianmu-storyboard-stream-lineage.js` | 是 |  |
| `qianmu-storyboard-stream-moment.js` | 是 |  |
| `qianmu-storyboard-stream-readiness.js` | 是 | A readiness proof narrows an already captured source. It never discovers new |
| `qianmu-storyboard-stream-recovery.js` | 是 |  |
| `qianmu-storyboard-stream-reference.js` | 是 | Persist only a bounded source proof, never a second copy of private prose. |
| `qianmu-storyboard-stream-scheduler.js` | 是 |  |
| `qianmu-storyboard-stream-source.js` | 是 |  |
| `qianmu-storyboard-subject-evidence.js` | 是 |  |
| `qianmu-storyboard-subject-map.js` | 是 |  |
| `qianmu-storyboard-utils.js` | 是 | 千幕·分镜 - 工具函数模块 |
| `qianmu-storyboard-variant-recovery.js` | 是 |  |
| `qianmu-storyboard-worldbook-view.js` | 是 | Pure markup: the caller owns worldbook reads, draft selection and confirmation. |
| `qianmu-storyboard-worldbooks.js` | 是 |  |
| `qianmu-storyboard.js` | 是 |  |

## Comfy／RunningHub 出图（65）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-comfy-audit.js` | 是 | Static accounting for explicitly supported native Comfy nodes, never graph execution. |
| `qianmu-comfy-auto-binding.js` | 是 | Persist only the chosen pool version. This reference is not an automation switch or execution permission. |
| `qianmu-comfy-auto-runtime.js` | 是 | Request-scoped candidate preparation. No provider submission, workflow edits, permanent locks or LLM calls. |
| `qianmu-comfy-character-contract.js` | 是 | Engine-specific character recipes. This module never reads files, contacts Comfy or edits a saved workflow. |
| `qianmu-comfy-character-plan.js` | 是 | Optional preparation only. The caller must still run node readiness, output auditing and admission before dispatch. |
| `qianmu-comfy-character-readiness.js` | 是 | Read-only per-shot verification, using the same explicitly selected requester as generation. |
| `qianmu-comfy-classification.js` | 是 | Lightweight declarations; no candidate selection, storage, network or execution authority. |
| `qianmu-comfy-cloud-execution.js` | 是 | One original shot through the existing cloud client. No topology mutation, |
| `qianmu-comfy-cloud-protocol.js` | 是 | Cloud request plans only. No IO, credentials, workflow edits or automatic protocol fallback. |
| `qianmu-comfy-cloud-readiness-client.js` | 是 | Reuse the existing account-bound cloud request path, without journal writes |
| `qianmu-comfy-cloud-request.js` | 是 | Browser-safe projection of an already prepared storyboard gateway request. |
| `qianmu-comfy-cloud-upload-contract.js` | 是 | Metadata-only upload plans and replies. Neither function grants file access, |
| `qianmu-comfy-cloud-workflow.js` | 是 | Bind host-issued uploads only at reference slots in the ORIGINAL template. |
| `qianmu-comfy-console.js` | 是 | Explicit workflow metadata only. Never an API target, authentication source or workflow import. |
| `qianmu-comfy-delivery-store.js` | 是 | Lazy, bounded delivery journal. Never stores a workflow, prompt, image or Key. |
| `qianmu-comfy-library-backup.js` | 是 |  |
| `qianmu-comfy-library-view.js` | 是 | Loaded only when opening the workflow library. Drafts never live in global ST settings. |
| `qianmu-comfy-library.js` | 是 | Account-scoped workflow documents. No generation or connection credentials. |
| `qianmu-comfy-lock-runtime.js` | 是 | Scene claims surround, but never replace, the independent image-admission and provider gates. |
| `qianmu-comfy-lock-store.js` | 是 | Independent lazy metadata store; never opens or upgrades voice, media or previous storyboard stores. |
| `qianmu-comfy-native-contract.js` | 是 |  |
| `qianmu-comfy-native-migration.js` | 是 |  |
| `qianmu-comfy-native-store.js` | 是 |  |
| `qianmu-comfy-new-execution.js` | 是 | Fresh generation only. Never apply this projection to archived jobs or retry payloads. |
| `qianmu-comfy-pool-backup.js` | 是 |  |
| `qianmu-comfy-pool-native-contract.js` | 是 |  |
| `qianmu-comfy-pool-native-store.js` | 是 |  |
| `qianmu-comfy-pool-store.js` | 是 | Lazy, account-scoped selection configuration. No workflow graphs, media, credentials or execution permissions. |
| `qianmu-comfy-pool-view.js` | 是 | Candidate maintenance is not a generation surface. Only explicit saved workflow versions may be enrolled. |
| `qianmu-comfy-preflight.js` | 是 | Local configuration checks before LLM spending; no remote readiness or paid probe is implied. |
| `qianmu-comfy-prompt.js` | 是 | Final prompt projection for a classified workflow (fixed route or editable workbench). Never rewrites a graph. |
| `qianmu-comfy-queue.js` | 是 | Page-local ordering only, never provider authorization or a durable lease. |
| `qianmu-comfy-readiness.js` | 是 | Read-only legacy /object_info contract inspection. Never execute a workflow or a descriptor's remote route. |
| `qianmu-comfy-recovery-action.js` | 是 | Manual receipt of an existing image. Never submit a new generation request. |
| `qianmu-comfy-recovery-client.js` | 是 | Comfy delivery and single cloud acceptance. Selected file metadata only; |
| `qianmu-comfy-reference-contract.js` | 是 | Lightweight file receipts only. No image bytes, implicit avatars or network access. |
| `qianmu-comfy-references.js` | 是 | Explicitly selected, immutable ST files. Loaded only for Comfy reference work. |
| `qianmu-comfy-resource-backup.js` | 是 | Portable configuration only. No execution, connection authority, media upload or workflow rewriting. |
| `qianmu-comfy-results.js` | 是 | Shared native-Comfy result contract; no provider submission, storage or polling. |
| `qianmu-comfy-route-contract.js` | 是 | Lightweight, version-pinned route identity. Not a workflow, credential, permission or execution receipt. |
| `qianmu-comfy-route-view.js` | 是 |  |
| `qianmu-comfy-route.js` | 是 | Lazy preparation may preserve same-account legacy originals. Saved graphs are |
| `qianmu-comfy-scene-backup.js` | 是 |  |
| `qianmu-comfy-scene-branch-result.js` | 是 |  |
| `qianmu-comfy-scene-catalogue.js` | 是 |  |
| `qianmu-comfy-scene-directory-write.js` | 是 |  |
| `qianmu-comfy-scene-directory.js` | 是 |  |
| `qianmu-comfy-scene-journal.js` | 是 |  |
| `qianmu-comfy-scene-lock.js` | 是 | Pure lifecycle for a program-confirmed scene. No scope inference, workflow execution or storage. |
| `qianmu-comfy-scene-native-contract.js` | 是 |  |
| `qianmu-comfy-scene-native-store.js` | 是 |  |
| `qianmu-comfy-scene-preservation.js` | 是 |  |
| `qianmu-comfy-scene-result.js` | 是 | Ephemeral authority issued only by the validated original-image archive path. |
| `qianmu-comfy-scene-review.js` | 是 |  |
| `qianmu-comfy-scene-task-navigation.js` | 是 | Read-only navigation to an existing log. This is not an archive proof, |
| `qianmu-comfy-scene-view.js` | 是 |  |
| `qianmu-comfy-selection.js` | 是 | Pure selection contract. This module cannot open storage, call an LLM, mutate a graph or authorize execution. |
| `qianmu-comfy-storage-accounting.js` | 是 |  |
| `qianmu-comfy-storage.js` | 是 | On-demand metadata inventory. Does not load workflow documents, render galleries or submit requests. |
| `qianmu-comfy-submission.js` | 是 | Lazy, identity-only preparation. No workflow copy, storage or provider IO. |
| `qianmu-comfy-targets-view.js` | 是 | Lazy current-connection management. Never sends model keys or contacts Comfy. |
| `qianmu-comfy-workbench-binding.js` | 是 | Small workbench provenance only. Parameters and prompt additions remain editable, not pinned to recipe defaults. |
| `qianmu-comfy-workbench.js` | 是 | Presentation-only, loaded on entry to the Comfy workbench. No network, storage or node execution. |
| `qianmu-comfy-workflow.js` | 是 | Qianmu's explicit API Workflow input slots. No node-name guessing, network or persistence. |
| `qianmu-runninghub-usage.js` | 是 | Task-level reported usage, never a price estimate or per-image sum. |

## 图库与图片（61）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-gallery-archive-coordinator.js` | 是 | One idle, add-only preservation pass per settled source. No startup scan, |
| `qianmu-gallery-archive-evidence.js` | 是 |  |
| `qianmu-gallery-archive-original.js` | 是 |  |
| `qianmu-gallery-archive-recipe.js` | 是 |  |
| `qianmu-gallery-archive-record.js` | 是 | Lossless single-record envelopes, independent of the live gallery and media. |
| `qianmu-gallery-archive-source.js` | 是 | Connect immutable record/page storage to the exact SAVED current-chat source. |
| `qianmu-gallery-archive-storage.js` | 是 | Add-only ST-native object storage. The gallery browser uses read methods only. |
| `qianmu-gallery-archive-supplement.js` | 是 |  |
| `qianmu-gallery-archive-version.js` | 是 | Shared, path-free source-version contract for native storage and discovery. |
| `qianmu-gallery-catalog-contract.js` | 是 | A rebuildable search index, not an asset/identity ledger or an original-file receipt. |
| `qianmu-gallery-catalog-management-view.js` | 是 |  |
| `qianmu-gallery-catalog-management.js` | 是 |  |
| `qianmu-gallery-catalog-store.js` | 是 |  |
| `qianmu-gallery-choice-picker.js` | 是 |  |
| `qianmu-gallery-collections-view.js` | 是 |  |
| `qianmu-gallery-continuity.js` | 是 |  |
| `qianmu-gallery-details-view.js` | 是 |  |
| `qianmu-gallery-directory-view.js` | 是 |  |
| `qianmu-gallery-directory.js` | 是 |  |
| `qianmu-gallery-evidence-source.js` | 是 |  |
| `qianmu-gallery-external-recipe-migration.js` | 是 |  |
| `qianmu-gallery-history-export.js` | 是 |  |
| `qianmu-gallery-inspector.js` | 是 | Capture values, not a mutable array. Detached/closed/replaced views fail closed. |
| `qianmu-gallery-keywords-view.js` | 是 |  |
| `qianmu-gallery-keywords.js` | 是 | Gallery metadata only: never a prompt fragment, generation route or identity. |
| `qianmu-gallery-local-recipe-current.js` | 是 |  |
| `qianmu-gallery-local-recipe.js` | 是 |  |
| `qianmu-gallery-membership.js` | 是 |  |
| `qianmu-gallery-narrative-inputs.js` | 是 |  |
| `qianmu-gallery-narrative.js` | 是 |  |
| `qianmu-gallery-original-client.js` | 是 |  |
| `qianmu-gallery-original-contract.js` | 是 | Shared browser/server contract. No filesystem imports or caller-selected paths. |
| `qianmu-gallery-original-export.js` | 是 |  |
| `qianmu-gallery-package-collections.js` | 是 |  |
| `qianmu-gallery-page-index.js` | 是 | Shared paging contract used by read-only version discovery. No migration, |
| `qianmu-gallery-preview-media.js` | 是 |  |
| `qianmu-gallery-preview-zoom.js` | 是 | Read-only image zoom/pan. No source lookup, download, media loading or persistence. |
| `qianmu-gallery-recipe-fields.js` | 是 |  |
| `qianmu-gallery-recipe-review-view.js` | 是 |  |
| `qianmu-gallery-record-fingerprint.js` | 是 | Hash-only capture: the same complete canonical record and strict JSON limits, |
| `qianmu-gallery-reviewed-recipe.js` | 是 |  |
| `qianmu-gallery-shot-reader.js` | 是 |  |
| `qianmu-gallery-snapshot-migration.js` | 是 |  |
| `qianmu-gallery-summary.js` | 是 | Render-local, metadata-only projection. Never retain this across a gallery |
| `qianmu-gallery-taxonomy.js` | 是 |  |
| `qianmu-gallery-window.js` | 是 | Display-only paging. Full records and selection remain owned by the gallery; |
| `qianmu-gallery-write-proposal.js` | 是 |  |
| `qianmu-image-admission.js` | 是 |  |
| `qianmu-image-attempt-store.js` | 是 |  |
| `qianmu-image-attempts.js` | 是 | Pure still-frame admission rules. Persistence must apply each operation inside one |
| `qianmu-image-channel.js` | 是 | Browser-wide NAI serialization. Only opaque key fingerprints and request |
| `qianmu-image-direct.js` | 是 | 千幕 · 浏览器生图直连适配层 |
| `qianmu-image-info-view.js` | 是 |  |
| `qianmu-image-models.js` | 是 | Shared model-catalog contract. No credentials, browser globals or generation requests. |
| `qianmu-image-recovery-cli.js` | 是 | Offline administrative entry, deliberately separate from plugin HTTP routes. |
| `qianmu-image-restore-client.js` | 是 |  |
| `qianmu-image-restore-contract.js` | 是 |  |
| `qianmu-image-service-client.js` | 是 | Optional service transport. Loading this module does not open storage or probe. |
| `qianmu-image-service-recovery.js` | 是 | Offline administration only; never expose this module as a normal retry route. |
| `qianmu-image-transport.js` | 是 | Explicit cross-family wire projection. Pure and bounded; native requests are never rewritten. |
| `qianmu-image-zoom.js` | 是 | Local image viewing only; never reads media metadata or starts network work. |

## Vibe／NAI（37）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-novel-service-channel-state.js` | 是 | Channel occupancy is not an image/encoding fee receipt. Each operation keeps its own historical ledger. |
| `qianmu-novel-vibe.js` | 是 |  |
| `qianmu-vibe-aggregate.js` | 是 |  |
| `qianmu-vibe-asset-contract.js` | 是 |  |
| `qianmu-vibe-asset-ref.js` | 是 | Lightweight settings/snapshot reference only. No database, image codec or worker at startup. |
| `qianmu-vibe-asset-store.js` | 是 |  |
| `qianmu-vibe-assets-worker.js` | 是 |  |
| `qianmu-vibe-assets.js` | 是 |  |
| `qianmu-vibe-encoding-contract.js` | 是 |  |
| `qianmu-vibe-encoding-retention.js` | 是 |  |
| `qianmu-vibe-encoding-store.js` | 是 |  |
| `qianmu-vibe-encoding.js` | 是 |  |
| `qianmu-vibe-file.js` | 是 |  |
| `qianmu-vibe-history.js` | 是 |  |
| `qianmu-vibe-library-assets.js` | 是 |  |
| `qianmu-vibe-library-view.js` | 是 |  |
| `qianmu-vibe-local-encoding-store.js` | 是 |  |
| `qianmu-vibe-native-encoding-store.js` | 是 |  |
| `qianmu-vibe-native-original.js` | 是 |  |
| `qianmu-vibe-native-store.js` | 是 |  |
| `qianmu-vibe-prepare.js` | 是 |  |
| `qianmu-vibe-preservation-view.js` | 是 |  |
| `qianmu-vibe-preservation.js` | 是 |  |
| `qianmu-vibe-receipt-accounting.js` | 是 | Verified immutable UTF-8 file bytes, not decoded receipt JSON, browser heap, |
| `qianmu-vibe-receipt-catalogue.js` | 是 |  |
| `qianmu-vibe-receipt-file.js` | 是 |  |
| `qianmu-vibe-receipt-lineage.js` | 是 |  |
| `qianmu-vibe-receipt-original.js` | 是 |  |
| `qianmu-vibe-recipe.js` | 是 | Bounded source metadata only. A URL is not an immutable content receipt. |
| `qianmu-vibe-restore.js` | 是 |  |
| `qianmu-vibe-review.js` | 是 |  |
| `qianmu-vibe-service-client.js` | 是 |  |
| `qianmu-vibe-stage-contract.js` | 是 |  |
| `qianmu-vibe-stage-native.js` | 是 |  |
| `qianmu-vibe-storage-accounting.js` | 是 |  |
| `qianmu-vibe-storage-summary.js` | 是 | On-demand, metadata-only bridge into the global storage card. No media or fee mutation. |
| `qianmu-vibe-storage.js` | 是 |  |

## 正文辅助（prose）与蜂巢（33）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-assistant-history-manager.js` | 是 |  |
| `qianmu-assistant-history-transfer.js` | 是 |  |
| `qianmu-assistant-history-view.css` | 是 |  |
| `qianmu-assistant-history-view.js` | 是 |  |
| `qianmu-assistant-storage-client.js` | 是 |  |
| `qianmu-assistant-storage-contract.js` | 是 | Size observations of owned ST files, not a conversation export or authority to |
| `qianmu-hive-commands.js` | 是 | Shared built-in commands; no runtime state or network dependencies. |
| `qianmu-hive-ownership.js` | 是 | Built-in floating controls must never be captured as external plugin entries. |
| `qianmu-hive-theme-logo.js` | 是 | Mechanically traced from assets/logos/qianmulogo.png by scripts/trace-hive-theme-logo.mjs. |
| `qianmu-prose-assistant-context.js` | 是 |  |
| `qianmu-prose-assistant-conversation-list.js` | 是 |  |
| `qianmu-prose-assistant-conversations.js` | 是 |  |
| `qianmu-prose-assistant-floor.js` | 是 |  |
| `qianmu-prose-assistant-history-contract.js` | 是 |  |
| `qianmu-prose-assistant-history-runtime.js` | 是 |  |
| `qianmu-prose-assistant-history.js` | 是 |  |
| `qianmu-prose-assistant-markdown.js` | 是 |  |
| `qianmu-prose-assistant-messages.js` | 是 |  |
| `qianmu-prose-assistant-native.js` | 是 |  |
| `qianmu-prose-assistant-panel.js` | 是 |  |
| `qianmu-prose-assistant-preferences.js` | 是 |  |
| `qianmu-prose-assistant-rename.js` | 是 |  |
| `qianmu-prose-assistant-request.js` | 是 |  |
| `qianmu-prose-assistant-session.js` | 是 |  |
| `qianmu-prose-assistant-source.js` | 是 |  |
| `qianmu-prose-assistant-storage.js` | 是 |  |
| `qianmu-prose-assistant-title.js` | 是 |  |
| `qianmu-prose-assistant-window.js` | 是 | Device-only geometry; no conversation content is stored here. |
| `qianmu-prose-assistant.css` | 是 | The detached assistant follows the API model card's type/control scale, not |
| `qianmu-prose-floor-entries.js` | 是 | Shared prose-floor helpers used by storyboard floor actions. |
| `qianmu-prose-floor-tools.js` | 是 |  |
| `qianmu-prose-hive.js` | 是 |  |
| `qianmu-prose-rich-compat.js` | 是 | A decorated message may contain ordinary prose before and after a rich card. |

## 角色、世界与设定（40）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-character-archive-session.js` | 是 |  |
| `qianmu-character-archive-store.js` | 是 |  |
| `qianmu-character-archive-view.js` | 是 |  |
| `qianmu-character-archive.js` | 是 | New image-generation identities. Never revive the retired characters/entities settings. |
| `qianmu-character-backup-file.js` | 是 |  |
| `qianmu-character-backup-restore.js` | 是 |  |
| `qianmu-character-casting.js` | 是 |  |
| `qianmu-character-chat-batch.js` | 是 |  |
| `qianmu-character-chat-draft.js` | 是 |  |
| `qianmu-character-import-view.js` | 是 | Compact exceptional review only; no ordinary migration/sync settings. |
| `qianmu-character-import.js` | 是 |  |
| `qianmu-character-library-backup.js` | 是 |  |
| `qianmu-character-migration-idle.js` | 是 |  |
| `qianmu-character-migration.js` | 是 |  |
| `qianmu-character-native-contract.js` | 是 |  |
| `qianmu-character-native-store.js` | 是 |  |
| `qianmu-character-reconciliation.js` | 是 |  |
| `qianmu-character-reference.js` | 是 | Engine-specific reference policy. No archive lookup, image decode or network at import time. |
| `qianmu-character-shot-edit.js` | 是 | Explicit per-image edits. Never read today's library during redraw or automatic generation. |
| `qianmu-character-shot-view.js` | 是 |  |
| `qianmu-character-source-backup.js` | 是 |  |
| `qianmu-character-source-native.js` | 是 |  |
| `qianmu-character-storage.js` | 是 |  |
| `qianmu-character-worker-storage.js` | 是 |  |
| `qianmu-user-alias-bindings.js` | 是 |  |
| `qianmu-user-alias-contract.js` | 是 |  |
| `qianmu-user-alias-runtime.js` | 是 |  |
| `qianmu-user-alias-view.js` | 是 |  |
| `qianmu-user-alias.js` | 是 |  |
| `qianmu-user-identity.js` | 是 | Decode exactly once. Case, Unicode normalization and literal percent signs are part of the avatar filename. |
| `qianmu-world-automatic-approval.js` | 是 | A bounded provenance receipt, not a live setting or a persistence claim. |
| `qianmu-world-automatic-host.js` | 是 |  |
| `qianmu-world-automatic-storage.js` | 是 |  |
| `qianmu-world-automatic.js` | 是 |  |
| `qianmu-world-ensemble.js` | 是 |  |
| `qianmu-world-gallery-keywords.js` | 是 | Ephemeral gallery metadata, separate from visual facts and execution receipts. |
| `qianmu-world-image-admission.js` | 是 |  |
| `qianmu-world-prompt-diagnostics.js` | 是 | Request-local world expression diagnostics. No storage, retries or submission |
| `qianmu-world-shot.js` | 是 | World-camera preparation only. No autonomous inference, archive mutation or media submission. |
| `qianmu-world-source.js` | 是 | Lightweight provenance only. No settings, media reads, network or generation. |

## 聊天、历史与保存（1）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-historical-gallery-consumer.js` | 是 | Optional read-only history consumer. The directory owns source validation; |

## 专注／阅读／文本（62）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-focus-cue-records.js` | 是 | Keeps cue record identity and legacy favorite contracts; persistent storage stays with the host. |
| `qianmu-focus-dialogue-autosave.js` | 是 | Serial editor writes: never replace a live textarea or rebase over another editor. |
| `qianmu-focus-dialogue-ui.js` | 是 |  |
| `qianmu-focus-dialogue.js` | 是 |  |
| `qianmu-focus-drawer.js` | 是 | Owns only drawer DOM; closing does not cancel media or change records. |
| `qianmu-focus-events.js` | 是 | Bind controls only for a freshly rendered focus page; no application singleton or timers. |
| `qianmu-focus-export.js` | 是 | Weekly image generation owns no persistent state and downloads only after successful PNG encoding. |
| `qianmu-focus-history.js` | 是 |  |
| `qianmu-focus-library-backup.js` | 是 | Reuse the bounded strict JSON reader used by resource packages. No URLs or credentials in this format. |
| `qianmu-focus-library-editor.js` | 是 |  |
| `qianmu-focus-library-runtime.js` | 是 |  |
| `qianmu-focus-library-store.js` | 是 | Lazy, separate IndexedDB namespace. Never upgrades the shared reader/TTS database. |
| `qianmu-focus-library-ui.js` | 是 |  |
| `qianmu-focus-library.js` | 是 | Dedicated focus recordings, not narration favorites or chat identity. |
| `qianmu-focus-lock.js` | 是 | Focus locks are application navigation boundaries, not an OS/browser security mechanism. |
| `qianmu-focus-preparation.js` | 是 | Owns preparation tickets only; adapters keep provider requests, storage and identity resolution outside. |
| `qianmu-focus-runtime.js` | 是 | Own only timer/listener lifetimes. Session state, media and persistence stay with callers. |
| `qianmu-focus-scene-prompts.js` | 是 | PROMPT-PENDING-FOCUS-SCENE: revise in the unified prompt-writing unit, not in this UI iteration. |
| `qianmu-focus-session.js` | 是 | Session transitions only. The host owns normalization, persistence, media and navigation. |
| `qianmu-focus-sound.js` | 是 | Owns only the completion/preview sound, never character speech or narration. |
| `qianmu-focus-speech.js` | 是 | Own only focus speech admission and audio identity; the shared TTS channel stays with the host. |
| `qianmu-focus-time.js` | 是 | Presentation/calendar helpers only. No settings, timers, DOM or storage ownership. |
| `qianmu-focus-view.js` | 是 | Transient view inputs only: no settings ownership, persistence, timers or host access. |
| `qianmu-focus-voice-cache.js` | 是 | Focus owns bounded memory references; persistent audio remains in the shared store. |
| `qianmu-focus-voice.js` | 是 | Persistent focus voice identity is a character avatar, never a chat or display name. |
| `qianmu-narrative-context.js` | 是 | Optional provenance on existing records, not a second ledger or an authorization grant. |
| `qianmu-narrative-ledger.js` | 是 | 千幕·共享叙事账本。纯数据合同：不读写 DOM、聊天、存储或网络。 |
| `qianmu-notes-device.js` | 是 | Device-only layout. Never store note prose, ST account settings or sync state. |
| `qianmu-notes-native-client.js` | 是 |  |
| `qianmu-notes-panel-sync.js` | 是 | Optional account sync controls for the existing non-modal notes portal. |
| `qianmu-notes-sync-client.js` | 是 | Same-origin ST transport only. No provider URL, token, or note geometry is accepted. |
| `qianmu-notes-sync-contract.js` | 是 | Account-wide plain-text originals. Geometry and device presentation never enter this contract. |
| `qianmu-notes-sync-runtime.js` | 是 | Local-first note sessions. The transport is injected; this module performs no network request itself. |
| `qianmu-notes-sync-store.js` | 是 | Account-scoped durable notes and outbox. Never opens or migrates the legacy notes database. |
| `qianmu-notes-theme.js` | 是 | Notes live outside the main panel. Update only their theme-bearing attributes; |
| `qianmu-notes.js` | 是 | 千幕 · 轻量便笺数据层 |
| `qianmu-reader-book-cleanup.js` | 是 | Worldbook targets and IO belong to the caller. Never discover or create targets mid-cleanup. |
| `qianmu-reader-center-view.js` | 是 | Display-only center components; callers own reading boundaries, filtering and guide state. |
| `qianmu-reader-identity-view.js` | 是 | Display-only inputs. Identity ownership, ST access and persistence stay with the caller. |
| `qianmu-reader-library-view.js` | 是 | Shelf cards only. Collection ownership, current metadata resolution, sorting and cover loading stay with the caller. |
| `qianmu-reader-package.js` | 是 | Reader packs contain original media, unlike the smaller configuration-only package. |
| `qianmu-reader-panel-view.js` | 是 | Display-only reading sidebars. Caller owns book, companion and search state; no persistence or DOM access. |
| `qianmu-reader.js` | 是 | 千幕 · 伴读模块纯逻辑层（解析 / 分章 / 切片） |
| `qianmu-text-collection-backup.js` | 是 |  |
| `qianmu-text-collection-capture.css` | 是 |  |
| `qianmu-text-collection-capture.js` | 是 |  |
| `qianmu-text-collection-editor.js` | 是 | Plain-text editing with real paragraphs. The browser owns caret movement, |
| `qianmu-text-collection-floor.css` | 是 | Only the collection's own message control. Inherit the ST toolbar theme. |
| `qianmu-text-collection-floor.js` | 是 |  |
| `qianmu-text-collection-host.js` | 是 |  |
| `qianmu-text-collection-image-dialog.css` | 是 |  |
| `qianmu-text-collection-image-dialog.js` | 是 |  |
| `qianmu-text-collection-images.js` | 是 | Plain-text image export. No storage, HTML rendering, object URLs or network. |
| `qianmu-text-collection-organization-view.css` | 是 |  |
| `qianmu-text-collection-organization-view.js` | 是 |  |
| `qianmu-text-collection-organization.js` | 是 | Classification is part of the collection document, not a second index or |
| `qianmu-text-collection-owner.js` | 是 |  |
| `qianmu-text-collection-panel.css` | 是 |  |
| `qianmu-text-collection-panel.js` | 是 |  |
| `qianmu-text-collection-source.js` | 是 |  |
| `qianmu-text-collection-view.js` | 是 |  |
| `qianmu-text-collection.js` | 是 | Collection operations share the supplied page/account document session. |

## 合奏、配方与包（47）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-bundle-carrier-contract.js` | 是 |  |
| `qianmu-bundle-carrier-native-contract.js` | 是 |  |
| `qianmu-bundle-carrier-native-raw.js` | 是 |  |
| `qianmu-bundle-carrier-native-store.js` | 是 |  |
| `qianmu-bundle-carrier-restore-contract.js` | 是 |  |
| `qianmu-bundle-carrier-restore.js` | 是 |  |
| `qianmu-bundle-carrier-storage-contract.js` | 是 |  |
| `qianmu-bundle-carrier-store.js` | 是 |  |
| `qianmu-bundle-carrier.js` | 是 |  |
| `qianmu-bundle-carriers-contract.js` | 是 |  |
| `qianmu-bundle-carriers.js` | 是 |  |
| `qianmu-bundle-mapping-contract.js` | 是 |  |
| `qianmu-bundle-mapping-restore.js` | 是 |  |
| `qianmu-bundle-mappings.js` | 是 |  |
| `qianmu-bundle-subject-map.js` | 是 |  |
| `qianmu-bundle-user-alias-contract.js` | 是 |  |
| `qianmu-bundle-user-alias.js` | 是 |  |
| `qianmu-creative-contract.js` | 是 | Pure output contract. It checks structure and explicit empty/duplicate items, |
| `qianmu-creative-prompts.js` | 是 | Approved creative text. Editorial and implementation notes are deliberately excluded. |
| `qianmu-creative-runtime.js` | 是 | Creative defaults and one-request state. No storage, network or model calls. |
| `qianmu-creative-social.css` | 是 | Scoped fictional forum/chat reading surfaces. All three families use the |
| `qianmu-creative-social.js` | 是 | Read-only fictional social panels. Reactions are bounded, session-local UI state: |
| `qianmu-ensemble-bindings.js` | 是 |  |
| `qianmu-ensemble-continuation.js` | 是 |  |
| `qianmu-ensemble-diagnostics.js` | 是 | Read-only, bounded projection of an already verified selection. Never use a |
| `qianmu-ensemble-editor.js` | 是 |  |
| `qianmu-ensemble-handoff.js` | 是 |  |
| `qianmu-ensemble-history.js` | 是 | Cross-floor descriptive style anchors, confined to the compiler's borrowed |
| `qianmu-ensemble-host.js` | 是 |  |
| `qianmu-ensemble-origin.js` | 是 | Descriptive style provenance, not an admission receipt or scene-continuity |
| `qianmu-ensemble-plan-storage.js` | 是 |  |
| `qianmu-ensemble-preparation.js` | 是 |  |
| `qianmu-ensemble-record.js` | 是 | Descriptive persisted data only. Loading a plan never imports a live execution session. |
| `qianmu-ensemble-recovery.js` | 是 |  |
| `qianmu-ensemble-route-view.js` | 是 |  |
| `qianmu-ensemble-scene-lock.js` | 是 | Request-local continuity constraints for the expression stage. The caller |
| `qianmu-ensemble-selection.js` | 是 | Pure, request-scoped style selection. This is not narrative planning, model |
| `qianmu-ensemble-storage.js` | 是 |  |
| `qianmu-ensemble-target-picker.js` | 是 |  |
| `qianmu-ensemble-ui.js` | 是 |  |
| `qianmu-ensemble-view.js` | 是 |  |
| `qianmu-recipe-archive-client.js` | 是 |  |
| `qianmu-recipe-archive-contract.js` | 是 | Lossless JSON recipe transport. This is not proof that a model/workflow can still run. |
| `qianmu-recipe-batch-contract.js` | 是 | Selector-only batches. References prove saved recipe copies, not permission to |
| `qianmu-recipe-restore-client.js` | 是 |  |
| `qianmu-recipe-restore-contract.js` | 是 |  |
| `qianmu-recipe-storage.js` | 是 |  |

## 外观、主题、字体与图标（21）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-appearance-actions.js` | 是 |  |
| `qianmu-appearance-portals.js` | 是 |  |
| `qianmu-appearance-runtime.js` | 是 |  |
| `qianmu-appearance-session.js` | 是 |  |
| `qianmu-appearance-settings.js` | 是 | Additive preferences: settings.theme remains the user's last classic choice. |
| `qianmu-font-account-sync.js` | 是 |  |
| `qianmu-font-builtins.js` | 是 | Reserved registry for fonts shipped by a future Qianmu release.  Built-ins |
| `qianmu-font-library-state.js` | 是 |  |
| `qianmu-font-library-view.js` | 是 |  |
| `qianmu-font-library.css` | 是 | Layout only: window, header, button and card materials share the main panel. |
| `qianmu-font-library.js` | 是 |  |
| `qianmu-font-local-store.js` | 是 | Local font bytes stay in this browser/account. The background account-sync |
| `qianmu-font-package.js` | 是 | Font ZIP v2: metadata is validated before writes; local originals are read one at a time. |
| `qianmu-font-runtime.js` | 是 | FontFace, not an external stylesheet, is the only path by which catalog CSS |
| `qianmu-font-sources.js` | 是 | Only validated font faces reach the runtime. Short original inputs remain inert edit metadata. |
| `qianmu-icon-renderer.js` | 是 | Icons by Iconsax - https://iconsax.io (Free License); familiar action subset Lucide 1.39.0 (ISC/MIT). See THIRD_PARTY_NOTICES.md. |
| `qianmu-style-recipe.js` | 是 |  |
| `qianmu-theme-menu.js` | 是 |  |
| `qianmu-theme-palette.js` | 是 | Pure, opaque sRGB palette tokens for the optional Qianmu theme studies. |
| `qianmu-theme-skins.css` | 是 | Optional skins over the real renderers. Load after style.css. |
| `qianmu-theme-surfaces.js` | 是 |  |

## 模型、配置与账户（26）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-account-identity.js` | 是 | Account identity is shared by ordinary tools as well as image generation. |
| `qianmu-account-local-store.js` | 是 | Shared lazy IndexedDB account-document transactions. Callers own schema, namespace and database. |
| `qianmu-config-apply.js` | 是 | Synchronous configuration handoff only; independent originals are never read/deleted. |
| `qianmu-config-connections.js` | 是 | Configuration-package policy only. Never scan/rewrite user prose, prompt text or media. |
| `qianmu-config-export.js` | 是 |  |
| `qianmu-config-undo-action.js` | 是 |  |
| `qianmu-config-undo.js` | 是 |  |
| `qianmu-llm-output.js` | 是 | 千幕 · 对话模型输出能力协商。只生成请求选项，不发起网络请求。 |
| `qianmu-mapping-import-contract.js` | 是 |  |
| `qianmu-mapping-import.js` | 是 |  |
| `qianmu-mapping-journal-native.js` | 是 |  |
| `qianmu-mapping-native-contract.js` | 是 |  |
| `qianmu-memory-context.js` | 是 | Read-only interoperability with gaga-dog-summary schema 6/7. |
| `qianmu-model-external.js` | 是 |  |
| `qianmu-model-host.js` | 是 |  |
| `qianmu-model-picker.js` | 是 |  |
| `qianmu-model-response.js` | 是 | Request-local response decoding. Never subscribes to host generation events. |
| `qianmu-openai-image-compat.js` | 是 | 千幕 · 自定义（兼容 OpenAI）生图能力档。 |
| `qianmu-portable-connection.js` | 是 |  |
| `qianmu-st-account-storage.js` | 是 |  |
| `qianmu-st-context-sources.js` | 是 |  |
| `qianmu-st-menu-entry.js` | 是 |  |
| `qianmu-storage-backup-view.js` | 是 |  |
| `qianmu-storage-cleanup-session.js` | 是 | One local cleanup at a time. Invalidating a session stops future work, not |
| `qianmu-storage-gallery-check.js` | 是 |  |
| `qianmu-yimu-companion.js` | 是 | Optional, explicit companion sharing. This bridge never owns or migrates a reader archive. |

## 提示词、美术方向与剧场（14）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-art-directions.js` | 是 | Program-owned visual defaults, not scene facts or an extra model request. |
| `qianmu-artist-prompt-layer.js` | 是 | Frozen syntax boundaries, not ownership of matching words elsewhere in a scene. |
| `qianmu-artist-prompt-review.js` | 是 |  |
| `qianmu-classic-palettes.js` | 是 | Existing classic descriptors and hive fills, shared without changing their values. |
| `qianmu-composition-schemes-view.js` | 是 |  |
| `qianmu-composition-schemes.js` | 是 | Named still-frame policies. Bindings carry their own policy so a standalone |
| `qianmu-film-editor-save.js` | 是 | One immutable, explicitly requested film save. Validation performs no writes. |
| `qianmu-plan-archive-write.js` | 是 | Immutable plan and recipe archive variants. Hashing finishes before the IndexedDB transaction. |
| `qianmu-production-packet.js` | 是 | 千幕·共享片场制片包。纯数据适配器：不读写 DOM、设置、聊天元数据或媒体二进制。 |
| `qianmu-prompt-formats.js` | 是 |  |
| `qianmu-still-frame-instructions.js` | 是 |  |
| `qianmu-tag-complete.js` | 是 |  |
| `qianmu-tags.js` | 是 | Local writing aids. These functions never choose a generation target or invoke a model. |
| `qianmu-theaters.js` | 是 | 千幕 (Qianmu) 内置剧场组「千幕小剧场」——与「吱吱小剧场」平行、独立版本管理 |

## 基础设施（存储、日志、迁移、加载）（24）

| 文件 | 发行 | 首行说明 |
| --- | --- | --- |
| `qianmu-blobstore.js` | 是 | 千幕 · 通用二进制存储层（IndexedDB） |
| `qianmu-client-activity.js` | 是 | Shared by the two media clients. Their public operations return promises; |
| `qianmu-current-chat-source.js` | 是 |  |
| `qianmu-data-migrations.js` | 是 | 千幕 V2 兼容门面。 |
| `qianmu-document-session.js` | 是 | A page/account-owned view of one ST document. Panels subscribe/unsubscribe; |
| `qianmu-feature-runtime.js` | 是 |  |
| `qianmu-feedback-report.js` | 是 | Public feedback is a separate, deliberately small contract. Never pass logs, |
| `qianmu-feedback-view.js` | 是 |  |
| `qianmu-idle-migration-scheduler.js` | 是 | Shared scheduling only: importing a library's idle policy must not load a |
| `qianmu-idle-preload.js` | 是 | Code-only warming: no text reads, DOM construction, database access or model calls. |
| `qianmu-input-boundary.js` | 是 |  |
| `qianmu-json-input.js` | 是 | Shared scanner extracted from the existing storyboard package reader. |
| `qianmu-library-backup.js` | 是 | Original-file library formats. Keep import admission and export warnings aligned. |
| `qianmu-main-tabs.js` | 是 | Main-panel tabs only. The fixed shell owns the two equal gutters; scrolling |
| `qianmu-mutation-journal-body.js` | 是 |  |
| `qianmu-mutation-journal-native.js` | 是 |  |
| `qianmu-native-review-contract.js` | 是 |  |
| `qianmu-original-image-zip.js` | 是 | Plain ZIP, stored entries only: PKWARE APPNOTE 4.3.7/4.3.12/4.3.16. |
| `qianmu-release-version.js` | 是 | Read-only metadata for the exact official branch ST has already checked. |
| `qianmu-resource-journal-contract.js` | 是 |  |
| `qianmu-resource-journal-native.js` | 是 |  |
| `qianmu-service-capabilities.js` | 是 |  |
| `qianmu-service-recovery-action.js` | 是 | Receipt of existing NAI service results only. No generation or task replay. |
| `qianmu-verified-progress-watch.js` | 是 | Only validated, live-scope progress may renew the idle deadline. A separate |
