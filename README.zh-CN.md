# Runwright

[English](README.md) | 简体中文

**为 LLM agent 提供可恢复的 durable run、人工管控、学习机制与类型化工作流 —— 可自托管，一份 SQLite 文件，零运行时依赖。**

Runwright 是一个可自托管的平台，为 LLM agent 补上 agent 循环本身并不提供的那些能力。它跑在一台机器上，所有数据集中保存在一份 SQLite 文件里，并通过统一的 provider 接口对接任意模型（Anthropic Messages、任何 OpenAI 兼容的 Chat Completions 服务，或测试、示例和基准测试所使用的确定性离线 "scripted" 模型）。

Agent 擅长把事情做出来，却不擅长记住自己已经做过。Runwright 在模型外围补上四件事：

- **Durable runs。** 每个 agent、revision、run 和 step 都会记入同一个 store。即使进程在一次 run 中途被杀掉，再次启动后也会从最后一个已完成的 step 继续；已完成的 step 绝不会再跑一遍。
- **管控（Control）。** 每个 tool 都有策略（`allow`、`ask`、`deny`）。Run 可以向人提问、等待审批，并受花费上限、tool-call 预算和回合上限约束。触及上限时，run 会暂停并说明还需要什么，而不是直接失败。
- **学习（Learning）。** Run 结束后，agent 会提出要保留的 notes 和 skills。Runwright 用代码加以检查、交由评分，把通过的内容版本化，并提供给该 agent 的下一次 run。
- **工作流（Workflows）。** 可重复的工作可以写成类型化、确定性的工作流文档（tool 调用、带类型化输出的模型步骤、带置信度阈值的决策、分支、有界的 map 与循环、子工作流、移交到 agent），而不是开放式循环。

在这四项之外，还有运维所需的配套：带 server-sent event 时间线的 HTTP API、CLI、无依赖的 TypeScript 客户端、单页 Web 控制台、cron 与带签名的 webhook 触发器，以及密封保存的 secrets。

> **状态：0.1.0，早期版本。** 核心功能已端到端打通，并由一套大规模的封闭测试套件覆盖（约 2 700 项测试，无需网络或密钥），但 API 和存储格式在 1.0 之前仍可能变化，代码也尚未经过独立的安全审计。在把它暴露到本机以外之前，请先阅读[安全速览](#安全速览)。

## 目录

- [运行要求](#运行要求)
- [快速开始](#快速开始)
- [示例](#示例)
- [使用真实模型](#使用真实模型)
- [从 TypeScript 调用](#从-typescript-调用)
- [核心概念](#核心概念)
- [文档](#文档)
- [性能](#性能)
- [范围](#范围)
- [安全速览](#安全速览)
- [开发](#开发)
- [项目结构](#项目结构)
- [许可证](#许可证)

## 运行要求

- Node.js **22.18 或更高版本**。在本仓库的 checkout 中，Node 会通过内置的类型擦除直接运行 TypeScript 源码；运行、测试和开发都不需要先执行构建步骤。
- **零运行时依赖。** 只用 Node 内置模块（`node:sqlite`、`node:http`、`node:crypto` 等）。`npm install` 只会拉取两个开发依赖（`typescript`、`@types/node`），用于类型检查和打包构建。
- npm 包随附带类型声明的编译后 JavaScript：`npm run build` 会写入 `dist/`，`npm pack` / `npm publish` 会先执行该步骤（`prepack`）。以这种方式安装后，`runwright` 可执行文件以及三个入口（`runwright`、`runwright/client`、`runwright/workflow`）都从 `node_modules` 加载。示例和测试套件在仓库里，不包含在 npm 包中。

## 快速开始

不需要 API key，也不需要网络：示例 agent 使用离线的 scripted 模型。请在仓库根目录执行以下命令。每一行都是一条命令；带 `&` 的那一行会在后台启动服务器。

```sh quickstart
npm install
node bin/runwright.ts serve &
node bin/runwright.ts agents save examples/ask-and-write/agent.json
node bin/runwright.ts runs start ask-and-write --message "Write a greeting"
node bin/runwright.ts runs wait @last        # exit 8
node bin/runwright.ts pendings list
node bin/runwright.ts runs answer @last "Ada"
node bin/runwright.ts runs wait @last
node bin/runwright.ts runs files @last greeting.txt
```

各步骤的含义：

1. `serve` 会启动 HTTP API，并带上一个进程内 runner。它监听 `127.0.0.1:7411`；若 7411 已被占用，则使用其后最多 20 个端口中的下一个空闲端口，并打印 URL、API token 文件路径以及数据目录（`~/.runwright`，或 `RUNWRIGHT_DATA_DIR`）。token 本身绝不会被打印出来。
2. `agents save` 把 agent 定义存为 agent `ask-and-write` 的 revision 1。
3. `runs start` 将一次 run 入队；runner 会立刻认领它。
4. Agent 通过 `ask_person` 工具向人提问，于是这次 run 会暂停。`runs wait` 返回退出码 **8**，表示「正在等待人工处理」，并列出未关闭的问题。
5. `pendings list` 把所有 run 中需要人工处理的事项集中列在一处。
6. `runs answer` 提交回答。某个 runner 会应用该回答，run 从停下的地方继续。
7. 此时 `runs wait` 以 **0** 退出：这次 run 已完成。
8. `runs files` 打印 `greeting.txt`，也就是 agent 写入该 run 工作区的文件。在终端里打印的是文件正文，`Hello, Ada!`。若不在终端中（管道传给其他程序，或使用 `--json`），则输出一份 JSON 文档：`{"path": "greeting.txt", "contentType": ..., "bytes": 12, "encoding": "utf8", "content": "Hello,
   Ada!\n"}`，正文在 `content` 中；`--out <file>` 则会把文件的原始字节写出去。

CLI 会自行从 `<data dir>/server.json` 和 `<data dir>/token` 找到本地服务器及其 token（可用 `--url`、`--token`、`--data-dir`，或环境变量 `RUNWRIGHT_URL`、`RUNWRIGHT_TOKEN`、`RUNWRIGHT_DATA_DIR` 覆盖）。客户端命令会最多等待 5 秒（`--connect-timeout`），以便应对仍在启动中的服务器，因此 `serve &` 后面那一行不会与它产生竞态。`@last` 表示最近创建的那次 run。在终端中，每条命令都会打印简短的人类可读文本；当 stdout 不是终端，或指定了 `--json` 时，每条命令都恰好打印一份 JSON 文档（帮助信息也不例外，格式为 `{"help": ...}`），只有 `runs timeline --follow` 会流式输出，每行一份 JSON 文档。`runs list` 和 `pendings list` 会打印一页结果以及下一页的 cursor（`--cursor`）；`runs timeline` 在读取 journal 时按页打印，因此永远不会把整份 journal 全部载入内存。除控制台页面本身以及带签名的 webhook 投递外，每个 API 操作都有对应的命令（[CLI 参考](docs/cli.md)）。

**控制台。** 打开 `http://127.0.0.1:7411/`（或 `serve` 打印出的 URL），并粘贴 `~/.runwright/token`（或 `<data dir>/token`）中的 token。控制台把 token 保存在该标签页的 `sessionStorage` 中，并且只通过 `Authorization` 头发送。

**停止。** 在前台运行 `serve` 的终端里按 Ctrl-C，或向进程发送 `SIGTERM`（对上面的后台任务可用 `kill %1`，或用 `<data dir>/server.json` 中的 pid 执行 `kill <pid>`）。第一次信号会优雅停止：runner 不再认领新的 run，进行中的模型调用和 tool 调用可以先结束，每次 run 会在下一个 step 边界被放回队列。若调用在 `runner.shutdownGraceMs`（10 秒）之后仍未结束，则会通过它们的 `AbortSignal` 中止（强制停止）：被中止的模型调用会按最坏情况计费，并在 run 继续时重新发起；只读或可恢复（resumable）工具被中止的调用会在 run 继续时再跑一次；除此之外，除下面所说的幂等（idempotent）工具外，其他被中止的调用都会记为 interrupted，并等待人工处理（重试、带着结果跳过，或取消）。声明为 `idempotent` 的工具，其未完成的调用只有在它开始之后该 run 没有其他写操作调用完成时，才会自行再跑一次；否则再跑一遍可能会撤销已经完成的工作，因此会作为 interrupted 调用等待人工处理。忽略该信号的工具会先被允许运行完毕。随后关闭 store。第二次信号（再按一次 Ctrl-C）会立即以退出码 1 结束进程，即使某个忽略信号的 tool 调用仍在运行；它持有的那些 run 会先被隔离（fence），因此其仍在进行中的操作无法再写入，并会在 lease 过期后被重新接管。

## 示例

三个示例都使用 scripted 模型离线运行，不需要密钥。每一个都会在临时数据目录中启动自己的 Runwright 实例，并打印发生了什么。

- **提问并写入**（`examples/ask-and-write`）：一个会向人提问、等待回答，并把回答写入文件的 agent。脚本会自行回答问题并打印该文件。

  ```sh
  node --disable-warning=ExperimentalWarning examples/ask-and-write/run.ts
  ```

- **分流工作流**（`examples/triage-workflow`）：带有类型化是/否决策的工作流。高置信度的答案会直接采用；低于置信度阈值的答案会转交给一个 agent，由其类型化结果替换该决策。

  ```sh
  node --disable-warning=ExperimentalWarning examples/triage-workflow/run.ts
  ```

- **学习**（`examples/learning`）：由一个设置了 `learning: true` 的 agent 把同一件工作跑两遍。第一次 run 会把事情做出来并保留一条 note；第二次 run 会拿到这条 note，用更少的回合完成，因此成本明显更低。脚本会打印两次的成本。

  ```sh
  node --disable-warning=ExperimentalWarning examples/learning/run.ts
  ```

## 使用真实模型

这些示例使用离线的 scripted 模型。若要使用托管模型，请把它的密钥存为密封 secret（值从 stdin 读入，之后再也不会显示），并在 agent 的 `model` 中指定 provider：

```sh
printf '%s' "$ANTHROPIC_KEY" | node bin/runwright.ts secrets set ANTHROPIC_API_KEY
```

```json
{
  "id": "researcher",
  "definition": {
    "name": "Researcher",
    "instructions": "Answer the question. Write your answer to answer.md.",
    "model": { "provider": "anthropic", "name": "claude-sonnet-5-5", "maxOutputTokens": 4096 },
    "tools": [{ "name": "web_fetch" }, { "name": "write_file" }, { "name": "ask_person" }],
    "limits": { "maxCostMicros": 500000, "maxTurns": 20, "maxToolCalls": 40 },
    "learning": true
  }
}
```

`maxCostMicros` 的单位是微美元（micro-dollars），因此该 agent 的 run 会在 $0.50 处停下，等待有人提高上限。`openai-compatible` 的用法相同，对应的密钥是 `OPENAI_API_KEY`；设置 `baseUrl` 以指向 OpenRouter、vLLM、本地服务器或任何其他 Chat Completions 端点，并用 `apiKeySecret` 指定保存其密钥的 secret 名称。内置价格表覆盖常见模型，也可以覆盖；没有标价的模型上的 run 绝不会报告 `$0`，而是报告 `unknown`。全部 provider 选项见[配置](docs/configuration.md)。

## 从 TypeScript 调用

`src/client` 中的客户端（在包中为 `runwright/client`）没有任何依赖，并覆盖全部 API。在快速开始中的服务器已运行、且已保存 `ask-and-write` agent 的前提下：

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "./src/client/index.ts";

const dataDir = process.env.RUNWRIGHT_DATA_DIR ?? join(homedir(), ".runwright");
const { url } = JSON.parse(readFileSync(join(dataDir, "server.json"), "utf8"));
const client = createClient({ baseUrl: url, token: readFileSync(join(dataDir, "token"), "utf8").trim() });

const { run } = await client.startRun({ agentId: "ask-and-write", message: "Write a greeting" });
let state = await client.waitForRun(run.id);          // returns when the run ends or needs a person
for (const pending of state.pendings) {
  if (pending.kind === "question") await client.answer(pending.id, "Ada");
}
state = await client.waitForRun(run.id);
console.log(state.run.status);                        // "completed"
const file = await client.readFile(run.id, "greeting.txt");
console.log(new TextDecoder().decode(file.body));     // "Hello, Ada!"
```

工作流既可以写成 JSON，也可以用 `src/workflow/builder.ts`（`runwright/workflow`）中的类型化 builder 来写；[examples/triage-workflow/workflow.ts](examples/triage-workflow/workflow.ts) 构建了一个完整示例。

## 核心概念

以下是简要说明。包含全部边界情况的精确规则，见[行为参考](docs/reference.md)及其所链接的各章。

- **一个 store，每次 run 一份 journal。** Agent、revision、run、command、pending、用量、学习条目、触发器以及密封 secrets，都存放在一份处于 WAL 模式的 SQLite 文件中。每次 run 都有一份只追加的 journal，每一次模型调用、tool 调用、提问和等待，都是其中带有稳定 key 的 *durable step*。
- **恢复就是重放（Resume is replay）。** 接管某次 run 的 runner 会从其 driver（agent 循环或工作流执行器）的开头重新调用。Journal 中已有的每个 step 会立刻返回已记录的结果，真正的工作从第一个未完成的 step 重新开始，因此已完成的 step 绝不会被重复执行。
- **Lease 与 epoch。** Runner 以会续期的 lease 持有一次 run，每次认领都会提升该 run 的 epoch。Store 只接受当前持有者在当前 epoch 下的写入；内置文件工具会通过写者 epoch 对应的目录暂存写入，因此在后继者接管之后，已失去 lease 的 runner 无法再写入任何内容。Lease 过期后（默认 30 秒），另一个 runner 会接管已失效 runner 的那些 run。
- **中断的 tool 会得到显式处理。** 每次 tool 调用都会在 journal 中记录为已开始和已完成。崩溃之后，只读和可恢复（resumable）的工具会自行再跑；其他任何未完成的调用都会等待有人重试、带着结果跳过，或取消这次 run。
- **所有需要人工处理的事项都是 pending。** 提问、审批、花费上限暂停、预算与回合上限暂停，以及中断的调用，共用同一种形态和同一份列表（`runwright pendings list`、控制台的「needs you」列表），并且能在重启后保留下来。
- **即便存在并行调用和重试，上限依然有效。** 在向 provider 发出每次请求之前，Runwright 会先预留该调用的最坏情况费用，只有在这次 run 仍不超过上限时才会真正发出。只要 provider 的实际计费不超过该最坏情况，一次 run 的花费就绝不会超过其上限。
- **学习会被检查，而不是被信任。** 提出的 notes 和 skills 会经过代码检查（不得含有 secrets，不得含有隐藏字符）、针对抓取页面等不可信文本的出处（provenance）检查，以及评分。任何可能来自不可信内容的条目都会留给人工处理。保留下来的条目会版本化，并在 token 预算内按相关性排序，提供给后续 run。持续被使用的 skill 可以被提升为经过校验的工作流。
- **工作流就是数据。** 工作流是一份 JSON 文档（`runwright.workflow/v1`），每个问题都会带着 JSON path 进行校验，可以在不调用任何外部能力的情况下 dry-run，可导出为图或 Mermaid 文本，并在所属 agent 的策略和限制下以可恢复的方式运行。

## 文档

| 指南 | 内容 |
|---|---|
| [行为参考](docs/reference.md) | 精确规则：journal 与重放、隔离（fencing）、pendings、限额与费用、脱敏、安全说明 |
| [架构](docs/architecture.md) | 持久化模型、run 状态机、runner 与 store |
| [工作流语言](docs/workflows.md) | 每一种节点类型、引用、校验代码、dry run、builder |
| [HTTP API](docs/api.md) | 全部路由、请求与响应、SSE 时间线、错误 |
| [CLI](docs/cli.md) | 全部命令与参数、输出模式、退出码 |
| [学习](docs/learning.md) | 提案、检查、出处、评分、选择、提升 |
| [安全](docs/security.md) | 威胁模型、token、密封 secrets、脱敏、SSRF 防护、工作区规则 |
| [配置](docs/configuration.md) | 每一项配置及其默认值、环境变量、provider 与价格、触发器 |

## 性能

测量方式：`npm run bench` 于 2026-11-16 在构建机器（Apple M2 Max，12 核，32 GB，macOS 26.6.2 arm64，Node.js v22.20.0）上完整跑了一次；你这边的数字会有所不同。

<!-- bench:begin -->
| 测量项 | 结果 |
|---|---|
| 已完成 run 的每秒数量，并发 1（400 次 run） | 612 runs/s |
| 已完成 run 的每秒数量，并发 4（400 次 run） | 842 runs/s |
| 已完成 run 的每秒数量，并发 16（400 次 run） | 1 007 runs/s |
| 已完成 run 的每秒数量，并发 64（400 次 run） | 1 019 runs/s |
| Journal 追加，每次 commit 一条记录（20 000 条） | 34 728 records/s |
| Journal 追加，每次 commit 八条记录（20 000 条） | 177 656 records/s |
| 从入队到认领，进程内唤醒（500 个样本） | p50 0.48 ms，p99 1.65 ms |
| 在持有它们的 runner 被 SIGKILL 后恢复 50 次 run（lease 1 000 ms，进行中的模型调用为 1 500 ms） | 全部在 1 025 ms 后重新接管，全部在 2 558 ms 后完成 |
| 时间线 SSE 扇出，50 个订阅者 × 200 个事件（从 commit 到收到字节） | p50 0.38 ms，p99 0.95 ms |
<!-- bench:end -->

测量内容：一个会写入一个文件的 scripted 两回合 agent，在并发 1、4、16 和 64 下已完成 run 的每秒数量；journal 每秒追加条数（每次 commit 一条记录，以及每次 commit 八条记录）；进程内唤醒时从入队到认领的延迟（p50 和 p99）；在持有这些 run 的 runner 被 SIGKILL 杀掉之后，第二个 runner 重新接管并完成 N 次 run 所需的时间；以及从一次 journal commit 到 K 个时间线 SSE 订阅者各自收到字节的延迟。

未与任何其他平台进行过一对一比较，也未作出此类声称。

## 范围

**包含：**

- 一份 SQLite store（WAL），带有 schema 迁移和版本表，隐藏在窄小的 store 接口之后。
- 带有 lease、心跳、epoch 隔离（fencing）、过期 lease 接管、通过 journal 重放恢复的 runner，以及进程内 runner 或共享同一数据目录的独立 `runwright runner` 进程。
- Tool 调用的已开始 / 已完成 / 已中断协议：只读和可恢复工具可重试；其他任何被中断的调用则交由人工决定（重试、带着结果跳过、取消）。声明为 `idempotent` 的工具，其未完成的调用只有在它开始之后该 run 没有其他写操作调用完成时，才会自行再跑一次；否则再跑一遍可能会撤销已经完成的工作，因此会作为 interrupted 调用等待人工处理。
- 带有上下文压缩、以及大型 tool 结果截断的 agent 循环（完整文本保存在工作区中）。
- 模型 provider：scripted（离线）、Anthropic Messages、OpenAI 兼容的 Chat Completions，支持任意 JSON 类型的结构化输出（object、array、标量或 `null`）；引擎会按每次尝试重试瞬时错误（有上限的指数退避加抖动，并完整遵守 `Retry-After`，直至可配置的上限），每一次尝试都单独准入并计费；每个 provider 回复有统一的大小上限（64 MiB，无论是否流式）；价格表可以覆盖。
- 内置工具：`read_file`、`write_file`、`edit_file`、`list_files`、`delete_file`、`ask_person`、`web_fetch`（带 SSRF 防护）、`shell`（默认关闭）、`run_workflow`，以及用于学习的 `recall`；带有 JSON Schema 参数校验的宿主工具注册表。
- Tool 策略、审批、花费上限、tool-call 预算、回合上限、pendings，以及文档化的 run 状态机。
- 工作流语言：校验器、dry run、图与 Mermaid 导出、类型化 TypeScript builder，以及带有每节点截止时间和有界重试的可恢复执行。
- 学习：提案、代码检查、出处、评分、带历史和 ETag 的版本化条目、预算内的 BM25 选择、每次 run 的 given/opened 记录、前后指标、将 skill 提升为经过校验的工作流。
- 触发器：五字段 cron（感知时区，错过的触发会合并）以及带重放窗口和投递去重的签名 webhook；每个触发器都带有上限，并且可以关闭。
- 密封 secrets（AES-256-GCM）、带机器可读描述的 bearer-token HTTP API、可从 `Last-Event-ID` 恢复的 SSE 时间线、CLI、无依赖的 TypeScript 客户端，以及单页 Web 控制台。
- 结构化 JSON 日志、优雅关闭，以及已完成 run 的 journal 归档（按记录流式写出，因此无论 journal 有多大，内存中只保留一页、寥寥几条记录）。

**明确不包含：**

- 供 agent 使用的远程或容器化计算机：没有 Docker 或云沙箱、桌面、手机或托管浏览器。Runwright 的工具只在每次 run 的本地工作区目录中操作。
- 用于驱动其他 agent harness 的适配器。Runwright 在模型 provider 之上运行自己的循环。
- Postgres 或任何第二种 store 后端、MCP 服务器、OAuth 登录、GitHub App 触发器、托管部署方案，以及 TypeScript 以外语言的客户端。
- Windows：未经测试。`shell` 需要 `/bin/sh`。
- 其他进程中的 runner 不会把模型的实时文本增量流转出来：SSE 流会携带任意 runner 的每条 journal 记录（通过轮询获取），但 `delta` 事件只来自服务器自己的进程内 runner。
- 每个数据目录只有一个 API token：没有用户账户，也没有按用户划分的权限。
- 没有 TLS：服务器使用明文 HTTP，默认绑定到 loopback。
- 没有用于轮换密封密钥（seal key）的命令。
- `web_fetch` 只支持 GET，并且只返回文本、JSON 和 XML 响应。

## 安全速览

- **默认绑定 loopback，并使用 bearer token。** 服务器绑定 `127.0.0.1`，除控制台页面、健康检查和带签名的 webhook 路由外，所有 API 路由都需要 `<data dir>/token`（权限 0600）中的 token。它使用明文 HTTP：若要绑定到其他地址，请先在前面加上 TLS 代理。
- **密封 secrets。** 模型密钥、工具密钥和 webhook 签名密钥均以 AES-256-GCM 密封。该 API 只写不读：它只会报告某个 secret 是否已设置，绝不会返回其值。
- **脱敏（Redaction）。** 已知的 secret 值（及其 base64、URL 和 JSON 转义形式）会在每条 journal 记录、存储值、API 响应、SSE 事件和日志行中被替换；调用方发来的文本会在入库前被脱敏。Run 写入其工作区的文件不会被脱敏。
- **隔离与约束（Fencing and confinement）。** 失去 lease 的 runner 无法再写入 store，也无法通过内置文件工具写入工作区。文件工具始终限制在该 run 的工作区目录内。
- **不可信内容。** `web_fetch` 带有 SSRF 防护（在每一次重定向跳转上都会拒绝私有、loopback、链路本地和元数据地址），其输出与 `shell` 输出一样，在学习流程中会被标记为不可信。
- **`shell` 默认关闭**，启用后需要审批。它不是沙箱：被允许的命令会以服务器所在用户的权限运行。
- **不受保护的部分：** 任何能读取数据目录的人，都能读到 token、密封密钥，从而读到所有 secret。

完整规则及其限制见[安全说明](docs/reference.md#security-notes)和 [docs/security.md](docs/security.md)。

## 开发

```sh
npm install          # typescript and @types/node, for type checking and the package build
npm run typecheck    # tsc --noEmit, strict
npm test             # the whole suite with node --test (hermetic: temp dirs, port 0, no network, no keys)
npm run bench        # prints one JSON benchmark report
npm run build        # compiles src and bin to dist/ (JavaScript and .d.ts) for the npm package
```

这套测试是封闭的（hermetic）：每个测试使用自己的临时数据目录和端口，都不需要网络或密钥。其中包含上面的 README 快速开始（按原文对真实进程执行）、示例 README，以及会在 run 中途用 SIGKILL 杀掉 runner、并检查该 run 能在不重复任何 step 的情况下完成的崩溃测试。

## 项目结构

```text
bin/runwright.ts      CLI entry point
src/store/            SQLite store, migrations, leases, commands, idempotency
src/engine/           durable step primitives, runners, limits, spend admission, pendings
src/agent/            the agent loop (prompt, compaction)
src/agents/           agent definitions and their validation
src/workflow/         workflow language: validator, dry run, graph, builder, executor
src/models/           scripted, Anthropic and OpenAI-compatible providers, price table
src/tools/            built-in tools, host-tool registry, workspace rules
src/learning/         proposals, checks, provenance, grading, selection, promotion
src/security/         sealed secrets and redaction
src/triggers/         cron and signed webhooks
src/server/           HTTP API and SSE
src/client/           dependency-free TypeScript client
src/console/          the one-page web console
src/cli/              CLI commands and output
src/bench/            the benchmark behind the Performance table
docs/                 reference documentation
examples/             runnable offline examples
test/                 node:test suite
```

## 许可证

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 The Runwright authors.
