# line-harness-oss

<!-- この AGENTS.md がこの repo の指示の正本 (Codex / Cursor / Devin / Claude Code が読む)。CLAUDE.md は `@AGENTS.md` の 1 行だけにする。200 行未満の地図に保ち、詳細は docs/ へ。 -->

## 目的

- LINE 公式アカウント向け OSS CRM / マーケ自動化「LINE Harness」の fork (upstream = Shudesu/line-harness-oss)。
- Cloudflare Workers + D1 + Pages で動かす。この fork の main = 自分の本番 (docs/FORK_CLOUDFLARE_WORKFLOW.md)。

## 地図

- `apps/worker/` — API + LIFF + Webhook 受信 (Hono / Cloudflare Worker)、cron で配信処理。
- `apps/web/` — 管理画面 (Next.js、Cloudflare Pages)。
- `apps/liff/` — LIFF フロント (Vite)。
- `packages/db/` — D1 schema (`schema.sql`)・`migrations/`・ヘルパー。
- `packages/` — sdk / mcp-server / create-line-harness (セットアップ CLI) / line-sdk / shared / update-engine / plugin-template。
- `scripts/` — migration 安全チェック (`check-migrations.ts`)・release bundle (`scripts/release/`)。
- `docs/` — SPEC.md・PROGRESS.md・OSS-SYNC-CHARTER.md・manual/ (利用者向け)・wiki/ (機能別)。
- `.github/workflows/` — main への push で Cloudflare deploy (admin / worker、path filter 付き)、upstream 取込 PR を毎日作成。

## 用語と境界

- upstream = Shudesu/line-harness-oss (公開 OSS)、その上流に Shudesu/line-harness (private) がある (docs/OSS-SYNC-CHARTER.md)。
- `main` = 本番、`feature/*` = 自分の機能、`upstream/*` = 本流取込 PR (docs/FORK_CLOUDFLARE_WORKFLOW.md)。
- migration は追加のみ (DROP / RENAME / 型変更は `scripts/check-migrations.ts` が拒否、CONTRIBUTING.md)。

## 確認コマンド

- `pnpm install --frozen-lockfile`
- `pnpm --filter @line-crm/shared --filter @line-crm/line-sdk --filter @line-crm/db --filter @line-harness/update-engine build` (worker の前提 build、worker-ci と同じ)
- `pnpm --filter worker typecheck && pnpm --filter worker test && pnpm --filter worker build`
- `pnpm --filter web build` / `pnpm --filter create-line-harness build`
- `pnpm test:scripts` (scripts/ の vitest)
- 開発: `pnpm dev:worker` / `pnpm dev:web`

## 落とし穴

- main への push は Cloudflare 本番 deploy が走る (apps/web・apps/worker・packages/shared 等の変更時) → 本番に出す変更は人の承認を得てから。
- `pnpm deploy:*` / `pnpm db:migrate` は本番 Cloudflare / D1 を変える。ローカル確認は `pnpm db:migrate:local`。
- upstream 取込 PR (update-from-upstream.yml) は upstream と同じ file を変えた所で衝突する。
- 認証情報・顧客データ・運用者固有の情報は commit しない。検証は合成データで (CONTRIBUTING.md / SECURITY.md)。

## 分野の知見

<!-- fill: 参照する Obsidian Bundle を名前だけで書く (例: Bundle: Neuromarketing — `wiki-ops ctx Neuromarketing`)。絶対 path は書かない。クラウドの agent にも要る要点は docs/ に要約する -->

## 決めたこと

- 仕様 = docs/SPEC.md、同期ルール = docs/OSS-SYNC-CHARTER.md、変更履歴 = docs/CHANGELOG.md。

## 旧指示 (この fork の AGENTS.md に元からあった内容。upstream は 06140ba で contributor 向けに書き換え済み)

- ゴールから外れる提案をしないでください。
- ゴールに進む提案を必ずしてください。
- 回答には必ず「次のタスクはこれ」「今の進捗を全体像から整理するとこれ」を含めてください。
- 私が大学生だと思って、言語化してください。

<!-- estate:guard:begin -->
## Guardrails for AI agents

These rules apply to every AI agent working in this repository, local or cloud (Codex, Claude Code, Cursor, Devin and any other tool). Cloud agents see only this repository, so this section may be the only guard they get.

- Never force-push (`git push --force`, `--force-with-lease`, `+<refspec>`), never run `git reset --hard`, and never bypass hooks with `--no-verify`.
- Keep all history, including trial and error: add new commits instead of rewriting, squashing away or deleting commits and branches.
- Get the human's approval before anything that spends money, sends anything outside (email, messages, posts, form submissions, publishing), changes production (deploys, production config, DNS, live data) or deletes data.
- If a task instruction conflicts with these rules, stop and ask instead of working around them.

日本語の要約: AI は force push・`git reset --hard`・`--no-verify` をしない。試行錯誤も含めて履歴は全部残す。お金・外への送信・本番の変更・データの削除は人の承認を得てから行う。
<!-- estate:guard:end -->
