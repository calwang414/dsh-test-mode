# dsh-test-mode

测试模式插件:在 DeepSeek Harness 对话中提供**动态插件测试**(装载 → 快照 → 场景断言 → 清理断言)、测试用例管理与 API 测试能力,所有产物保存在工作区共享的 `test-mode/` 目录中。

本项目**参考 `dsh-ui-design` 的插件工程形态**实现(独立 npm 包 + `cordis.patch.yml` 层栈入口 + 会话模式 + Host/Client 双端),前端为 React 原生视图(无 iframe)。

## 目录结构

```text
dsh-test-mode/
├── package.json      包元数据:dsh.bundle / dsh.client 清单、peer 依赖、./preset ./skill 导出
├── cordis.patch.yml  插入 profile 层栈的入口(id + name)
├── README.md
├── lib/              Host 端:index.js(路由 + 写盘校验/自动提交钩子)、preset.js(测试模式会话行)、
│                     skill.js(技能提供者)、plugin-test.js(核心测试引擎)、
│                     client.js(React 原生对话视图)
├── assets/           plugin-testing 技能正文(plugin-testing.md)
└── smoke/            测试引擎冒烟测试(真实 Cordis 运行时验证三阶段契约)
```

## 测试模式(会话模式)

测试模式预设由插件包的 `cordis.patch.yml` **以 `@deepseek-ai/dsh-agent-preset` 声明行随包发布**(与 `dsh-ui-design` 同一机制),安装插件并重启后,会话模式选择器即出现「测试模式」,无需运行时写入用户预设目录:

```yaml
- insert:
    - id: dsh-test-mode
      name: '@calwang414/dsh-test-mode'
    - id: preset-dsh-test-mode
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dsh-test-mode
        name: 测试模式
        description: …
        order: 6
        plugins: [ …16 行… ]
```

- 模式选择器里出现「测试模式」,选中后会话按该组合装载;
- 组合里的两个会话行由包自身 `exports` 解析(无需绝对路径):
  - `@calwang414/dsh-test-mode/preset`:注册「测试工作流」system-prompt 段 + 监听 `agent/created` 自动创建 `test-mode/` 目录;
  - `@calwang414/dsh-test-mode/skill`:向**本模式作用域层**注册技能提供者,只有测试模式会话能在技能目录看到并加载,其他模式不可见;
- 预设随插件包版本发布,升级插件即升级预设。

## 技能(测试模式专属)

| 技能 | 内容 | 许可 |
|---|---|---|
| `plugin-testing` | 动态插件测试契约:三阶段断言、套件 JSON 格式、test-mode/ 项目结构(`assets/plugin-testing.md`) | MIT(本项目) |

技能随插件打包,仅在测试模式的技能目录中可见;模型接到测试任务时按需加载。

## 工作区级共享项目

与原版「每个会话一个测试目录」不同,本项目为**工作区级共享**:

- 所有会话(无论哪个 sessionId)的 Test 视图都指向 `<工作区>/test-mode/` 这一个项目;
- 项目文件直接放在 `test-mode/` 根:assets/(接口/UI 资产)、cases/(用例=资产组合)、reports/(最新/历史报告)、manifests/(被测插件源码)、api/(旧项目/环境数据,已迁移)、legacy-*/(旧 plans/reports/results 归档);
- **旧数据迁移是安全默认**:`POST /api/migrate/assets` 默认 dry-run,必须 `{"apply": true}` 才写盘;已存在 `cases[].assets` 的用例只合并、绝不覆盖,写盘前自动备份 `cases/` 到 `backup-assets-migration-*` 并校验引用数不减少;
- **迁移保留步骤数据**:旧用例 `steps[].data` 写入 `assets[].data`(同一资产重复步骤按顺序保留);已迁移丢失 data 的存量工作项执行时只读回退(唯一值才回退),不改文件;
- 多会话并发编辑由 host 的文件操作锁与原子写保护。

## 动态插件测试(核心能力)

测试对象是**动态 Cordis 插件**——本会话通过 `@pluginId` 定义或从源码装载的插件。
每个测试套件按**三阶段契约**执行(见 `lib/plugin-test.js` 与技能 `plugin-testing`):

1. **装载前快照**:记录基线——`tools.schemas()` 工具清单;
2. **场景断言**:在隔离作用域(`ctx.extend()` + `fiber`)装载被测插件后逐条断言——工具可见性(schema 字段精确匹配)、事件通路(探针 + payload)、服务提供(方法存在)、工具执行(返回/错误);
3. **清理断言**:`fiber.dispose()` 后自动派生断言——每个可见工具 `tool.gone`、每个提供过的服务 `service.gone`,证明副作用随 fiber 销毁(HMR 安全)。

**工作原理**:

- **Host 端**(`lib/index.js`):注册 `/dsh-test-mode/api/run` JSON API——接收 `{ name, source, assertions }`,源码求值(vm 沙箱,与 `cordis_define` 的 code.host 同形),在隔离作用域装载、断言、卸载,返回三阶段报告;
- **测试引擎**(`lib/plugin-test.js`):`ctx.plugin()` 返回的 fiber 提供作用域隔离与卸载;`tools.schemas()` 做基线对比;`ctx.on` 探针验证事件通路;
- **客户端**(`lib/client.js`):注册测试模式的对话视图标签(React 原生,无 iframe;顶层:基础配置 / 资产库 / 测试工作项 / 报告;资产库内含「接口」「UI 组件」「UI 流程」子标签,测试工作项内含「功能测试」「e2e测试」「性能测试」「安全测试」四个标签页),跟随当前会话——只有当前会话是测试模式时才注册,切到其他模式立即注销(与 ui-design 同门控);
- **会话行**(`lib/preset.js`):测试模式组合内装载,注册测试工作流提示段 + 自动创建 `test-mode/` 目录。

**断言语义边界**(与仓库 HMR 安全测试对齐):

- 清理断言只派生**注册表级可观察项**(工具/服务)——事件监听器是否随 fiber 移除是黑盒,探针无法区分"插件监听器"与"探针自己",不做伪验证;
- 插件对事件的**业务响应**用组合断言验证:触发事件后断言插件暴露的服务状态变化;
- 测试引擎观察真实 Cordis 语义,刻意不复制 host-runner 的受限门面(被测插件是用户信任的源码)。

## 测试用例管理

用例以 JSON 文件存放在 `test-mode/cases/`,字段:name、description、priority(high/medium/low)、preconditions、steps(数组:action/expected/requestRef)、tags、status(draft/active/archived):

- `GET/POST /api/cases` — 列表/新建;
- `GET/PUT/DELETE /api/cases/:id` — 详情/更新/删除(所有请求带 workspaceId);
- **步骤绑定(API / UI / 手动)**:每个步骤可选择绑定——API 请求(`requestRef`: projectId/collectionId/requestId)或 UI 脚本(`uiRef`: scriptId),编辑器里通过「绑定」类型下拉 + 引用下拉配置;混合用例 = UI 操作 + 接口验证 + 断言编排在同一个用例里,按步骤顺序执行;手动步骤执行时跳过;
- **步骤数据覆盖(`data`)**:步骤可写 `data = { url?, body?, query?, headers? }` 覆盖所绑请求的数据(字段可省,未提供的回退请求配置);请求配置中的 mock 数据是**接口测试的参考示例**(API 列表执行时使用),用例步骤 data 覆盖它,且 **data 的字段结构必须对齐参考示例结构**(保存校验校验结构,提示词约束对齐示例);编辑器里 API 绑定步骤有数据覆盖编辑区(URL/Body/Query/Headers);
- **执行用例**:`POST /api/cases/:id/run` — 按 `assets` 顺序执行资产,变量在资产间流动;通过/失败只更新资产状态与统计,不生成报告;
- **测试资产**:`assets/api/<id>.json`、`assets/ui/<id>.json`(component/flow);首次执行成功即固化(solid),失败为 failed;配置变更后视为过期,需重跑;待测资产查询 `GET /api/assets/pending`,批量补测 `POST /api/assets/run-batch`;
- **技能(按需加载,仅测试模式可见)**:自带 `plugin-testing`(动态 Cordis 插件测试三阶段契约);
- **内置工作流技能**:`test-mode-workflow`(资产/工作项字段、JSON 示例、断言/环境/数据工厂、UI 定位与等待、失败归因详情)、`api-testing-assets` / `ui-e2e-assets` / `performance-testing-assets` / `security-testing-assets`(按四类工作项路由到对应方法);常驻提示词只保留契约与规则(约 4.2k 字),细节按需加载;
- **内置第三方测试技能(随包发布,无需下载)**:来自 [awesome-qa-skills](https://github.com/naodeng/awesome-qa-skills)(PolyForm Noncommercial 1.0.0,见 `assets/skills/qa/NOTICE.md`):`test-case-writing`、`test-case-reviewer`、`equivalence-partitioning`、`boundary-value-testing`、`api-testing`、`api-negative-testing`、`ui-test-playwright`、`ui-test-selector-review`、`api-security-testing`、`performance-testing`;
外部开源技能放到 `~/.dsh/test-mode-skills`、`<workspace>/.dsh/test-mode-skills` 或 `DSH_TEST_MODE_SKILLS` 指定目录即可被本插件会话加载,其他模式不可见;支持 `<name>/SKILL.md` 与 `<name>.md`(YAML frontmatter:name/description);
- **固定报告看板**:执行后自动覆盖写 `reports/latest.json`(只存统计:覆盖率/通过率/按模块/失败名+错误摘要,以及测试工作项名称/类型/结果/需求/资产名/断言数);用户可随时保存历史报告到 `reports/history/`(不可变),看板为图表形式(六维健康度雷达、资产状态环图、按模块/资产类型堆叠条形图、工作项分布环图+类型条、模块×测试类型覆盖热力图、历史趋势折线),工作项明细可展开;不保存请求/响应/步骤明细;
- **标签分类管理**:标签库按分类组织(`categories: [{name, tags}]`,默认 测试类型/功能模块/未分类;旧平铺 `tags` 自动迁移),基础配置→标签可增删分类/标签、移动标签;标签筛选作为高级筛选默认收起,点击「标签筛选」才展开;独立成行、按分类分组,每类默认显示最常用的 6 个(已选始终保留),其余「更多」展开,且只显示当前 tab 实际使用的标签;
- **标签筛选与按标签回归**:资产库/工作项支持标签 chips 筛选;资产查询支持 `GET /api/assets?tags=a,b`,工作项查询支持 `GET /api/cases?tag=a`,批量执行支持 `POST /api/assets/run-batch { tags }`;资产标签不在标签库时软提示(不拒绝);
- **安全回归支持**:安全专用资产(`security.category`:无凭证/不存在ID/错误泄露/越权)可一键脚手架生成(`POST /api/security/scaffold`,默认 dry-run);安全资产断言期望 2xx 会软提示;- **UI 资产粒度软校验**:component 应单页面、≤6 步、≥1 条断言;跨页/步数过多/无断言时 API 返回 `warnings`(不拒绝保存);`GET /api/assets/granularity` 查看汇总,`POST /api/assets/granularity-report` 生成 `test-mode/granularity-report.md` 整改清单;
- **测试工作项**:`cases/<id>.json`,按 `type` 分功能测试/e2e测试/性能测试/安全测试四类;字段:标题(name)、优先级(priority)、关联需求(requirement)、自动化状态(automation: manual/auto/partial)、结果(result: not_run/passed/failed/blocked/skipped)、关联缺陷(defects 票号/链接数组)、资产组合(assets);
- **固定报告**:执行后自动覆盖 `reports/latest.json`;用户可随时保存历史报告(`POST /api/reports/history`),默认保留、由用户手工删除;报告页含图表看板、失败摘要与历史趋势;
- **搜索筛选**:用例视图支持关键字(名称/描述/标签)、优先级、状态、标签过滤;`archived` 状态默认折叠,可勾选「显示归档」;
- **保存校验**:用例/项目/资产的保存做结构校验——字段缺失、枚举非法(priority/status/method/断言类型)、`requestRef`/`uiRef`/资产引用不存在的资源都会被 400 拒绝,报错信息含具体位置(如 `steps[1].requestRef points to a missing resource…`),供智能体按报错修正;
- **文件写入自动校验**:智能体用 write/edit 工具写入 `test-mode/` 下的用例/项目/脚本文件后,`tools/post-execute` 钩子自动校验结构,校验失败以工具失败结果反馈(含具体位置),模型必须修正后重写;
- **自动提交**:test-mode 文件写盘校验通过后,自动 `git add/commit` **仅该文件**(提交信息 `test-mode: <路径> 更新`)——AI 生成的资产/用例/变更清单全程留痕、可回滚;工作区需位于 git 仓库内(否则静默跳过,不影响执行);如需关闭,在 `cordis.patch.yml` 该插件行加 `config: { autoCommit: false }`;
- 模型可直接读写用例文件,Test 视图与模型共用同一存储。

## 组件测试 · 接口(原 API 测试)

- **项目**:`test-mode/api/projects/<id>.json`,字段 name、baseUrl、collections(集合数组);
- **请求**:字段 name、method、url(相对路径拼接 baseUrl,或绝对 URL)、headers、query、body、assertions、extract;
- **基础配置(独立页面,原「环境」页,含「环境 / 标签 / 数据参考 / 数据工厂」四个子标签)**:「环境」子标签管理测试环境——name + variables(KV 编辑器,值支持 `{{VAR}}`/`{{rand.*}}`/`{{factory.*}}` 执行时动态展开)、设为默认、删除;默认环境 id 存 `test-mode/settings.json`,**所有执行(API/用例/UI/计划)未指定环境时自动使用默认环境**;
- **环境**:`test-mode/api/environments/<id>.json`,字段 name、variables;`GET /api/environments` 返回 `defaultEnvironmentId`,`POST /api/environments/:id/default` 设为默认;首个环境自动成为默认;
- **标签库(基础配置页「标签」子标签)**:`test-mode/tags.json`({ tags: string[] })——用例 tags 只能从标签库选择,新增/删除走 `GET/POST /api/tags`、`DELETE /api/tags/:name`;首次使用自动从现有用例收集标签;用例保存校验拒绝库外标签;用例编辑器改为标签 chips 点选(不再自由输入);
- **数据库参考数据(基础配置页「数据参考」子标签)**:`test-mode/dbdata/` 固定目录——用户从数据库导出的表结构与测试数据,不直连数据库;`schema.md`(可选)+ `<表名>.csv/.md/.xlsx`(首行表头,xlsx 每 sheet 一张表);`GET /api/dbdata` 解析返回各表字段/行数/样例;智能体生成 mock 测试数据与断言时以此为事实来源,保证贴近真实;
- **变量替换**:url/headers/query/body 支持 `{{VAR}}` 占位符,优先级——请求级 variables > 环境变量;请求可声明 `extract`(响应 JSON 路径 → 变量)供同一集合的后续请求使用;
- **数据工厂(内置)**:`{{rand.<type>}}` 语法在执行时动态生成测试数据——phone(11 位手机号)、email、name(中文姓名)、idcard(身份证)、uuid、timestamp/timestamp_s、date、number:min:max、string:length;基础配置的「数据工厂」子标签默认展示这 10 个内置生成器(「内置」徽章,只读,`{{rand.*}}` 引用),请求编辑器的 Body 区有生成器按钮一键插入;
- **数据工厂(自定义)**:「基础配置 → 数据工厂」子标签在默认内置生成器下方可配置自己的生成器——key(引用名)+ 模板(pattern),模板可嵌套内置 `{{rand.*}}` 与其他自定义生成器;执行时用 `{{factory.<key>}}` 引用;`test-mode/datafactory.json` 存储,含 CRUD 与实时预览 API;自定义 key 与内置重名时自定义优先展示;
- **断言类型**:`status`(状态码)、`header`(响应头)、`body`(响应文本)、`json`(JSON 路径 `$.a.b[0].c`)、`duration`(耗时上限),操作符 eq/ne/gt/ge/lt/le/contains/regex;
- **执行**:`POST /api/run-request` 单请求、`POST /api/run-collection` 整个集合(变量在请求间流动);集合执行自动生成报告写入 `test-mode/reports/`;
- **执行历史详情**:历史条目保存完整请求/响应体,`GET /api/history/:id` 可回看;
- **OpenAPI 导入**:`POST /api/import/openapi` — 粘贴 OpenAPI 3.x JSON spec,按 operation tag 分组自动生成项目集合(含 baseUrl/query 参数/默认 2xx 状态断言);OpenAPI 2.0 与 YAML 文本会拒绝。

## 测试计划

计划 = 一批用例 + 集合 + UI 脚本的一键回归组合,实体存 `test-mode/plans/<id>.json`:

- `GET/POST /api/plans`、`GET/PUT/DELETE /api/plans/:id` — 计划 CRUD(创建/编辑时绑定环境 `environmentId`,存于计划实体;`template: true` 存为模板,不可直接执行,只能「从模板新建」);
- `POST /api/plans/incremental-preview` — 增量展开预览(不落盘):返回变更接口/变更用例/覆盖用例/UI 脚本/缺口清单与来源拆分;
- `POST /api/run-plan` — 依次执行计划内全部条目(用例/集合/UI 脚本),结果聚合为一份报告;执行环境优先用计划绑定的环境,未绑定则回退默认环境;`failedOnly: true` 只重跑上次报告中失败的条目;报告含 `entriesSnapshot`(展开快照)与逐结果 `caseId/projectId/scriptId` 身份;
- **条目类型**:`{kind:'case',caseId}`、`{kind:'collection',projectId,collectionId}`、`{kind:'ui',scriptId}`、`{kind:'incremental',since,modules?}`——增量条目执行时按「变更清单 → 请求级 updatedAt → 文件 mtime → 依赖反查」四层信号展开(见下);
- **迭代增量(版本迭代后)**:
  - **变更清单** `test-mode/changelogs/<id>.json`(`GET/DELETE /api/changelogs`):重导 OpenAPI(同名项目更新式导入,保留项目 id)自动 diff 出 added/modified/removed 接口并写清单;AI 可按发布说明维护 modules/changedCases/changedScripts;手动删除接口自动记录;
  - **请求级 updatedAt**:保存/导入时 diff 打标,增量精确到单个接口(旧数据回退项目文件时间);
  - **依赖反查**:变更接口 → 覆盖用例(步骤 requestRef/data.url/"METHOD /path");变更元素(元素库 updatedAt)→ 引用脚本(脚本步骤 element key);变更 dbdata 表 → `dependsOn` 声明该表的用例;增量条目 `modules` → 按标签命中用例;
  - **归因辅助**:报告详情中失败接口若出现在变更清单,标注「本版本已变更」——先确认期望是否随版本更新,再判断是否缺陷;
  - **存量用例补绑**:用例页「AI 生成 · 智能绑定接口」为 prose 步骤批量补 requestRef,接通覆盖图谱;
- **计划页(对话标签)**:
  - **多选弹窗**:用例(搜索 + 标签筛选 + 全选当前)、集合(项目 + 多选 + 「全选全部项目」一键全量)、UI 脚本(多选),替代逐个下拉选择;
  - **增量变更弹窗**:基线时间(默认最近计划执行)+ **变更模块(标签)声明** → 预览(来源拆分:变更清单/文件变更/表依赖/模块声明;UI 脚本计数;无覆盖用例的缺口接口)→ 添加增量条目;
  - **模板**:编辑时可「存为模板」;模板区一键「从模板新建」;
  - **复制**、**重跑上次失败**(只跑失败条目)、**智能推荐**(最近失败接口覆盖的用例一键补入);
  - **AI 生成 · 排计划**:描述意图(全量/增量/按模块),智能体读变更清单与项目文件后直接生成计划文件。

## 组件测试 · UI 脚本(引擎:Playwright + 系统 Chrome)

UI 脚本由 Host 半内置的 Playwright(`playwright-core`)直接驱动**系统 Chrome**,不依赖会话里的浏览器工具、不需要额外浏览器插件:

- **运行环境**:`playwright-core` 随插件安装(无浏览器下载、无安装脚本),默认 `channel: 'chrome'` 复用系统 Google Chrome,headless 执行;
  - `DSH_TEST_BROWSER_EXECUTABLE` 指定 Chrome/Chromium 可执行文件(优先级最高);
  - `DSH_TEST_BROWSER_CHANNEL=chrome|msedge` 选择浏览器;`DSH_TEST_BROWSER_HEADFUL=1` 有头执行(调试用);
- **脚本**:`test-mode/ui/scripts/<id>.json`,步骤序列——open(导航)、click/type(元素定位,自动等待可操作性)、press(按键)、assert_text/assert_url/assert_title/assert_element(断言)、eval(任意 JS,`exportAs` 导出变量)、wait(等待)、screenshot(截图);
- **元素库**:`test-mode/ui/elements.json` 单文件,`{ key, selector, page, description }` — 脚本步骤用 `element: <key>` 引用,可复用;
- **页面元素探测**:`POST /api/ui/probe { url }` — 服务端用 Playwright 打开页面并返回候选交互元素(tag/文本/id/name/testid/role/css),供 AI 生成元素库/脚本(替代在会话里调用浏览器工具);
- **失败取证**:断言/动作失败自动截图(落在 `test-mode/ui/screenshots/`),并附带 console 错误、页面异常、失败请求诊断;
- **联动**:text/url/expression 支持 `{{VAR}}`、`{{rand.*}}`、`{{factory.<key>}}` 数据工厂;
- **API**:`GET/POST /api/ui/scripts`、`GET/PUT/DELETE /api/ui/scripts/:id`;`GET/POST /api/ui/elements`、`GET/PUT/DELETE /api/ui/elements/:id`;`POST /api/ui/run`(执行脚本,失败默认停止,`continueOnError` 继续)、`POST /api/ui/probe`;报告的 `driver` 字段记录引擎/浏览器版本/是否 headless;
- **报告**:UI 执行结果写入 `test-mode/reports/`(kind: ui),历史 tab 可回看。

## 执行报告

- 报告存放在 `test-mode/reports/<id>.json`:name、kind(request/case/collection/plan)、startedAt/finishedAt、durationMs、summary(total/passed/failed/skipped)、results(逐项:pass/status/durationMs/逐条断言);
- 执行历史追加在 `test-mode/api/history.json`(保留最近 200 条,含完整请求/响应 detail);
- `GET /api/reports` 列表、`GET/DELETE /api/reports/:id` 详情/删除;
- 报告视图含「报告 / 历史」双 tab:历史 tab 可展开每次执行的请求/响应/断言详情;
- **可视化**:报告详情页含通过率环形图(SVG)、失败分布(按断言类型)、耗时分布(逐请求)——手写 inline SVG,无图表库依赖;
- **Markdown 导出**:`GET /api/reports/:id/export?format=md` — 生成含汇总、结果表格、失败详情的 Markdown,落盘 `test-mode/exports/<id>.json`;报告详情页「导出 Markdown」按钮一键复制到剪贴板。

## 安装

```sh
# 从源码目录安装到 web profile
cd <plugins 仓库根目录>
dsh plugin --profile web add ./dsh-test-mode
# 或打包后安装:pnpm pack && dsh plugin --profile web add ./dsh-test-mode-0.1.0.tgz
# 重启 dsh
```

> 重新打包时 tarball 必须使用 `package/` 顶层目录(npm pack 风格):pnpm 对没有
> `package/` 前缀的 tarball 会剥离第一层目录,导致 `lib/` 被拍平、`exports["./client"]`
> 指向的 `lib/client.js` 缺失、客户端 bundle 无法加载。当前脚本:
> `tar -czf dist/dsh-test-mode-0.1.0.tgz -C <临时目录> package`(临时目录内为
> `package/` + lib、presets、assets、cordis.patch.yml、package.json、README.md、LICENSE)。

## 发布(版本更新时)

日常 push 不会发布任何东西;**只有推送版本 tag(`vX.Y.Z`)才会触发 GitHub Actions
自动打包并创建 Release**(workflow: `.github/workflows/release.yml`)。

```sh
# 1. 更新 package.json 的 version(如 0.1.1)
# 2. 更新 RELEASE_NOTES.md 的变更说明(发布说明正文)
# 3. 打版本 tag 并推送 → Actions 自动: npm pack 生成 dsh-test-mode-<version>.tgz
#    → 创建 Release(标题 dsh-test-mode vX.Y.Z,正文取 RELEASE_NOTES.md)并附加安装包
git tag v0.1.1
git push origin v0.1.1
```

如需重新发布同一版本(如首次 workflow 配置后补发):删除并重建 tag 即可触发
`git push origin :refs/tags/v0.1.0 && git tag v0.1.0 && git push origin v0.1.0`。

## 使用

1. 在工作区目录启动 dsh web,新建对话;
2. 在会话模式选择器选择**测试模式**——选择后该工作区根目录会自动创建 `test-mode/` 目录;
3. 对话视图切换到 **组件测试 / 用例 / 计划 / 报告** 标签(组件测试内含「接口」「UI 脚本」子标签):用例管理(创建/编辑步骤/绑定请求/执行)、API 测试(项目→集合→请求树,环境选择,单请求与集合执行)、计划(组合用例+集合一键回归)、报告(执行结果汇总、历史回看、逐断言详情);
4. 或在对话里指挥智能体:描述被测插件行为或 API 场景 → 模型按工作流契约写源码/套件/项目 → 通过 API 运行 → 结果落盘 `test-mode/results/` 与 `test-mode/reports/`。

## 构建与开发

- `lib/` 是可直接运行的产物,改完即生效(重启 dsh);
- `lib/client.js` 遵循 `__ModuleLoader__.load` 协议,手写 React.createElement(无 JSX 编译步骤),`id` 必须等于 package.json 的完整包名(改包名时务必同步);
- 冒烟测试:`node smoke/smoke-test.mjs`(需要能解析 @deepseek-ai/cordis 等 peer 依赖);
- 需要 TypeScript 源码时可参照上游结构自行重建构建链。

## 内部标识

| 位置 | 值 |
|---|---|
| `cordis.patch.yml` entry id | `dsh-test-mode` |
| 视图 slot id(`lib/client.js`) | `dsh-test-mode-view` |
| API 路由 | `/dsh-test-mode` |
| 预设 id / 模式目录 | `dsh-test-mode` |

> 注意:若与其他插件注册相同的视图 slot id 或路由,会产生冲突,安装前请确认唯一。
