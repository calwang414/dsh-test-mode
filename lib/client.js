/**
 * dsh-test-mode Client 半:注册测试模式的对话视图标签(React 原生,无 iframe),
 * 跟随当前会话——只有当前会话是测试模式时才注册,否则注销。
 *
 * 视图(基础配置内含环境/标签/数据参考/数据工厂子标签;组件测试内含接口/UI 脚本子标签):
 * - 基础配置(Config):环境、标签库、数据参考、数据工厂;
 * - 组件测试(Component Test)·接口:项目→集合→请求树,请求编辑(method/url/headers/
 *   query/body/断言/变量提取),环境变量选择,单请求执行与集合执行;
 * - 组件测试(Component Test)·UI 脚本:UI 脚本与元素库,Playwright 执行;
 * - 用例管理(Test Cases):用例 CRUD(名称/描述/优先级/前置/步骤/标签);
 * - 计划(Plans):用例/集合/UI 脚本组合、增量、模板、AI 排计划;
 * - 报告(Reports):执行报告列表 + 详情(逐请求断言结果)。
 *
 * 样式:全部通过 inline style 引用 harness 语义 token(var(--dsw-alias-*)),
 * 自动适配明暗主题;hover/选中态用组件内 state 实现,对齐 trajectory
 * 视图的交互语言(interactive-bg-hover 悬停、品牌色 inset ring 选中)。
 *
 * 协议:window.__ModuleLoader__.load({ id, factory }),id 必须等于
 * package.json 的完整包名。手写 React.createElement(无 JSX 编译步骤)。
 * @module @calwang414/dsh-test-mode/client
 */

window.__ModuleLoader__.load({
  id: "@calwang414/dsh-test-mode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { useEffect, useState } = react;

    const TEST_MODE_PRESET_ID = "dsh-test-mode";
    const ROUTE_ROOT = "/dsh-test-mode";

    // ── 设计 token(harness 语义别名,明暗自动适配) ────────────────────────

    const T = {
      bgBase: "var(--dsw-alias-bg-base)",
      bgLayer1: "var(--dsw-alias-bg-layer-1)",
      bgLayer2: "var(--dsw-alias-bg-layer-2)",
      bgLayer3: "var(--dsw-alias-bg-layer-3)",
      borderL1: "var(--dsw-alias-border-l1)",
      borderL2: "var(--dsw-alias-border-l2)",
      borderL3: "var(--dsw-alias-border-l3)",
      labelPrimary: "var(--dsw-alias-label-primary)",
      labelSecondary: "var(--dsw-alias-label-secondary)",
      labelTertiary: "var(--dsw-alias-label-tertiary)",
      labelCaption: "var(--dsw-alias-label-caption)",
      hover: "var(--dsw-alias-interactive-bg-hover)",
      active: "var(--dsw-alias-interactive-bg-active)",
      hoverSolid: "var(--dsw-alias-interactive-bg-hover-solid)",
      brand: "var(--dsw-alias-state-business-primary)",
      brandTint: "var(--dsw-alias-state-business-tertiary)",
      success: "var(--dsw-alias-state-success-primary)",
      successTint: "var(--dsw-alias-state-success-tertiary)",
      error: "var(--dsw-alias-state-error-primary)",
      errorTint: "var(--dsw-alias-state-error-secondary)",
      warn: "var(--dsw-alias-state-warn-primary)",
      warnTint: "var(--dsw-alias-state-warn-tertiary)",
      focus: "var(--dsw-alias-brand-primary-new-colorprimary-new-color)",
      fontXxs: "var(--dsw-font-xxs-12)",
      fontXs: "var(--dsw-font-xs-13)",
      fontXsStrong: "var(--dsw-font-xs-strong-13)",
      fontXl: "var(--dsw-font-xl-24)",
      fontMono: "var(--dsw-font-markdown-code-block)",
    };

    // ── 共享布局样式 ──────────────────────────────────────────────────────

    /** 视图外壳:与 trajectory 同款 full-bleed 固定高度容器。 */
    const rootStyle = {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      minHeight: 0,
      boxSizing: "border-box",
      position: "relative",
      color: T.labelPrimary,
      background: T.bgLayer1,
    };

    /** 顶部工具栏:sticky + 底部分隔线(参照 TrajectoryToolbar)。 */
    const toolbarStyle = {
      display: "flex",
      flex: "none",
      alignItems: "center",
      gap: 12,
      boxSizing: "border-box",
      width: "100%",
      minHeight: 40,
      padding: "0 16px",
      borderBottom: `1px solid ${T.borderL2}`,
      background: T.bgLayer1,
    };

    const toolbarTitle = {
      font: T.fontXsStrong,
      color: T.labelPrimary,
      whiteSpace: "nowrap",
    };

    const toolbarSpacer = { flex: 1 };

    /** 内容区滚动容器。 */
    const scrollStyle = {
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      boxSizing: "border-box",
    };

    /** 内容列:居中定宽(参照 TrajectoryTurn.body 的 880px 居中)。 */
    const contentColumn = {
      display: "flex",
      flexDirection: "column",
      gap: 10,
      boxSizing: "border-box",
      width: "100%",
      maxWidth: 880,
      margin: "0 auto",
      padding: "14px 16px 24px",
    };

    /** 卡片:bg-layer-3 + l2 边框 + 8px 圆角(参照 TrajectoryCell)。 */
    const cardStyle = {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      boxSizing: "border-box",
      padding: "10px 14px",
      borderRadius: 8,
      border: `1px solid ${T.borderL2}`,
      background: T.bgLayer3,
      minWidth: 0,
    };

    /** 分区标签(表单字段名)。 */
    const fieldLabel = {
      font: T.fontXxs,
      fontWeight: 500,
      color: T.labelTertiary,
      marginBottom: 4,
    };

    /** 输入框:layer-2 底 + l2 边框。 */
    const inputStyle = {
      boxSizing: "border-box",
      width: "100%",
      padding: "5px 9px",
      borderRadius: 6,
      border: `1px solid ${T.borderL2}`,
      background: T.bgLayer2,
      color: T.labelPrimary,
      font: T.fontXs,
      outline: "none",
    };

    /** 等宽输入(textarea / body / 结果)。 */
    const monoStyle = {
      ...inputStyle,
      font: T.fontMono,
      lineHeight: "1.5",
      resize: "vertical",
      minHeight: 60,
    };

    /** 空态(加载中 / 无数据)。 */
    const emptyStyle = {
      display: "grid",
      placeContent: "center",
      gap: 6,
      minHeight: 160,
      padding: 32,
      color: T.labelTertiary,
      textAlign: "center",
      font: T.fontXs,
    };

    // ── 交互组件(hover/选中态用 state,对齐 harness 交互语言) ────────────

    /**
     * 按钮:variant = default(幽灵)/ primary(品牌填充)/ danger(危险)。
     * hover 用 interactive-bg-hover;primary hover 用按钮语义 hover。
     */
    function Button(props) {
      const { variant = "default", children, onClick, disabled, style, ...rest } = props;
      const [hovered, setHovered] = useState(false);
      const base = {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        boxSizing: "border-box",
        height: 26,
        padding: "0 10px",
        border: 0,
        borderRadius: 6,
        cursor: disabled ? "default" : "pointer",
        font: T.fontXs,
        fontWeight: 500,
        whiteSpace: "nowrap",
        ...style,
      };
      let background = "transparent";
      let color = T.labelSecondary;
      if (variant === "primary") {
        background = T.brand;
        color = "var(--dsw-alias-label-primary-foreground)";
      } else if (variant === "danger") {
        color = T.error;
      } else if (variant === "custom") {
        color = T.brand;
        background = T.brandTint;
      }
      const merged = {
        ...base,
        color,
        background: disabled
          ? (variant === "primary" ? T.brandTint : "transparent")
          : hovered
            ? (variant === "primary" ? "var(--dsw-alias-button-primary-hover)" : (variant === "danger" ? "var(--dsw-alias-interactive-bg-hover-danger)" : T.hover))
            : background,
        opacity: disabled ? 0.55 : 1,
      };
      return react.createElement("button", {
        type: "button",
        ...rest,
        style: merged,
        disabled,
        onClick: disabled ? undefined : onClick,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      }, children);
    }

    /**
     * 可点击行(树节点 / 列表项):hover 用 interactive-bg-hover,
     * 选中用品牌色 inset ring(参照 TrajectoryCell.selected)。
     */
    function Row(props) {
      const { selected, onClick, style, children, title } = props;
      const [hovered, setHovered] = useState(false);
      const merged = {
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxSizing: "border-box",
        width: "100%",
        minHeight: 30,
        padding: "0 8px",
        borderRadius: 6,
        cursor: "pointer",
        font: T.fontXs,
        color: selected ? T.labelPrimary : T.labelSecondary,
        background: selected
          ? T.active
          : hovered ? T.hover : "transparent",
        boxShadow: selected
          ? `inset 0 0 0 2px ${T.focus}`
          : "none",
        ...style,
      };
      return react.createElement("div", {
        role: "button",
        tabIndex: 0,
        title,
        style: merged,
        onClick,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      }, children);
    }

    /** 状态徽章:语义色文本 + 淡色底。 */
    function Badge(props) {
      const { tone = "neutral", children } = props;
      const tones = {
        neutral: { color: T.labelSecondary, background: "transparent", border: T.borderL2 },
        success: { color: T.success, background: T.successTint, border: "transparent" },
        error: { color: T.error, background: T.errorTint, border: "transparent" },
        warn: { color: T.warn, background: T.warnTint, border: "transparent" },
        brand: { color: T.brand, background: T.brandTint, border: "transparent" },
      };
      const t = tones[tone] ?? tones.neutral;
      return react.createElement("span", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          height: 18,
          padding: "0 6px",
          borderRadius: 5,
          font: T.fontXxs,
          fontWeight: 500,
          whiteSpace: "nowrap",
          ...t,
        },
      }, children);
    }

    // ── 自研弹窗(Tauri WebView 不支持 window.confirm/prompt/alert, ──────
    // ── 原生对话框恒不弹出:confirm 返回 falsy、prompt 返回 null,导致    ──
    // ── 删除/新建等按钮静默失效,因此全部换成 React 弹窗)               ──

    /** 全屏遮罩 + 居中卡片(绝对定位,覆盖当前视图 Tab)。 */
    const overlayStyle = {
      position: "absolute",
      inset: 0,
      zIndex: 100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(0, 0, 0, 0.45)",
    };

    const dialogCardStyle = {
      ...cardStyle,
      width: 340,
      maxWidth: "calc(100% - 40px)",
      gap: 12,
      padding: "16px 18px",
      boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
    };

    /** 确认弹窗:替代 window.confirm。message 为提示文本,confirmText 默认「删除」。 */
    function ConfirmDialog(props) {
      const { message, confirmText = "删除", onConfirm, onCancel } = props;
      return react.createElement("div", { style: overlayStyle, onClick: onCancel },
        react.createElement("div", { style: dialogCardStyle, onClick: (e) => e.stopPropagation() },
          react.createElement("div", { style: { font: T.fontXsStrong, color: T.labelPrimary, lineHeight: 1.5, wordBreak: "break-word" } },
            message),
          react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            react.createElement(Button, { onClick: onCancel }, "取消"),
            react.createElement(Button, { variant: "danger", onClick: onConfirm }, confirmText),
          ),
        ),
      );
    }

    /** 输入弹窗:替代 window.prompt。Enter 提交,Escape / 点遮罩 / 取消关闭。 */
    function PromptDialog(props) {
      const { title, initial = "", placeholder, onConfirm, onCancel } = props;
      const [value, setValue] = useState(initial);
      const submit = () => { if (value.trim()) onConfirm(value.trim()); };
      return react.createElement("div", { style: overlayStyle, onClick: onCancel },
        react.createElement("div", { style: dialogCardStyle, onClick: (e) => e.stopPropagation() },
          react.createElement("div", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, title),
          react.createElement("input", {
            style: inputStyle,
            placeholder,
            value,
            autoFocus: true,
            onChange: (e) => setValue(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel(); },
          }),
          react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            react.createElement(Button, { onClick: onCancel }, "取消"),
            react.createElement(Button, { variant: "primary", onClick: submit, disabled: !value.trim() }, "确定"),
          ),
        ),
      );
    }

    // ── 共享小组件 ────────────────────────────────────────────────────────

    /** 键值对编辑器(用于 headers/query/variables/extract)。 */
    function KeyValueEditor(props) {
      const { value, onChange, keyPlaceholder, valuePlaceholder } = props;
      const update = (index, field, next) => {
        const rows = value.map((item, i) => (i === index ? { ...item, [field]: next } : item));
        onChange(rows);
      };
      const add = () => onChange([...value, { key: "", value: "" }]);
      const remove = (index) => onChange(value.filter((_, i) => i !== index));
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        value.map((item, index) => react.createElement("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center" } },
          react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: keyPlaceholder ?? "key", value: item.key,
            onChange: (e) => update(index, "key", e.target.value) }),
          react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: valuePlaceholder ?? "value", value: item.value,
            onChange: (e) => update(index, "value", e.target.value) }),
          react.createElement(Button, { onClick: () => remove(index), style: { padding: "0 6px", height: 22 } }, "×"),
        )),
        react.createElement(Button, { onClick: add, style: { alignSelf: "flex-start", height: 22, padding: "0 8px" } }, "+ 添加"),
      );
    }

    /** 键值对编辑器数据归一化:对象(后端格式)或数组(旧数据)都转成 [{key, value}] 行。 */
    const kvRows = (value) => {
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => ({ key, value: String(item ?? "") }));
      return [];
    };
    /** 键值对行 → 对象(空 key 丢弃;已是对象则原样返回)。服务端执行器要求对象格式。 */
    const kvObj = (value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      return Object.fromEntries((value ?? []).filter((row) => row && row.key.trim()).map((row) => [row.key.trim(), row.value]));
    };

    /** 断言编辑器(API 测试)。 */
    function AssertionEditor(props) {
      const { value, onChange } = props;
      const update = (index, field, next) => {
        const rows = value.map((item, i) => (i === index ? { ...item, [field]: next } : item));
        onChange(rows);
      };
      const add = () => onChange([...value, { type: "status", operator: "eq", expected: 200 }]);
      const remove = (index) => onChange(value.filter((_, i) => i !== index));
      const typeOptions = ["status", "header", "body", "json", "duration"];
      const operatorOptions = ["eq", "ne", "gt", "ge", "lt", "le", "contains", "not_contains", "regex", "matches"];
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        value.map((item, index) => react.createElement("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center" } },
          react.createElement("select", { style: { ...inputStyle, flex: 1 }, value: item.type ?? "status",
            onChange: (e) => update(index, "type", e.target.value) },
            typeOptions.map((t) => react.createElement("option", { key: t, value: t }, t))),
          react.createElement("select", { style: { ...inputStyle, flex: 0.7 }, value: item.operator ?? "eq",
            onChange: (e) => update(index, "operator", e.target.value) },
            operatorOptions.map((o) => react.createElement("option", { key: o, value: o }, o))),
          (item.type === "json")
            ? react.createElement("input", { style: { ...inputStyle, flex: 1.2 }, placeholder: "path ($.a.b[0])", value: item.path ?? "",
              onChange: (e) => update(index, "path", e.target.value) })
            : (item.type === "header")
              ? react.createElement("input", { style: { ...inputStyle, flex: 1.2 }, placeholder: "header name", value: item.header ?? "",
                onChange: (e) => update(index, "header", e.target.value) })
              : react.createElement("span", { style: { flex: 1.2 } }),
          react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "expected", value: String(item.expected ?? ""),
            onChange: (e) => update(index, "expected", e.target.value) }),
          react.createElement(Button, { onClick: () => remove(index), style: { padding: "0 6px", height: 22 } }, "×"),
        )),
        react.createElement(Button, { onClick: add, style: { alignSelf: "flex-start", height: 22, padding: "0 8px" } }, "+ 添加断言"),
      );
    }

    // ── 一键智能生成(ask-ai 风格):点击按钮把提示词填入对话输入框 ──────
    // 通过 conversation.view 的 owner prop `inputActions.setDraft(text)` 实现,
    // 用户可补充后发送,智能体按提示词执行(生成/校验/验证闭环由提示词约束)。

    /** 截断摘要,控制输入框文本长度。 */
    const clampText = (text, max) => {
      const s = String(text ?? "");
      return s.length > max ? `${s.slice(0, max)}…` : s;
    };

    /** 标签整理提示词(基于产品文档/代码,非测试用例)。 */
    function buildTagPromptAll({ tags }) {
      return [
        "请为测试项目设计标签体系:",
        `- 当前标签库:${(tags ?? []).join(", ") || "(空)"}`,
        "依据来源(请在下方补充):1) 产品文档位置(如 test-mode/dbdata/schema.md、docs/ 目录或任意文档文件路径);2) 项目源码位置(分析代码里的业务模块)。",
        "要求:1) 先读取你提供的文档/代码,按「业务模块 + 场景 + 测试类型」提炼标签体系,每个测试工作项 2-4 个标签;2) 给出标签库的增删建议(新增标签通过「基础配置」页添加);3) 标签命名简洁一致(建议中文:如 登录/订单/回归/冒烟/安全);4) 标签必须来自文档/代码中的真实模块与场景,不要凭空编造;5) 完成后按校验报错修正。",
      ].join("\n");
    }

    /** mock 测试数据提示词(目标接口资产 / 缺省全部接口),携带默认环境变量。 */
    function buildMockPrompt({ asset, projects, env }) {
      const list = (projects ?? []).filter(Boolean);
      const scopeLines = [];
      if (asset) {
        scopeLines.push(`- 目标:接口资产「${asset.name ?? asset.id}」(${asset.request?.method ?? "GET"} ${asset.request?.url ?? ""})`);
        if (asset.baseUrl) scopeLines.push(`- baseUrl:${asset.baseUrl}`);
      } else {
        const requests = list.flatMap((project) =>
          (project.collections ?? []).flatMap((collection) =>
            (collection.requests ?? []).map((request) => `${project.name}/${collection.name}「${request.name || request.url}」(${request.method ?? "GET"} ${request.url ?? ""})`),
          ),
        );
        scopeLines.push(`- 目标:当前资产库中的接口(共 ${requests.length} 个)`);
        scopeLines.push(`- 接口清单:${clampText(requests.join("; "), 900) || "(暂无接口资产,请先在资产库新建或导入)"}`);
      }
      const envLine = env && Object.keys(env).length > 0
        ? `- 默认环境变量:${Object.entries(env).map(([key, value]) => `{${key}}=${clampText(String(value), 40)}`).join(", ")}`
        : "- 默认环境:暂无变量(可在「基础配置」页配置环境)";
      return [
        "请为以下接口生成/更新测试数据(mock 数据):",
        ...scopeLines,
        envLine,
        "要求:1) 为每个接口的 `request.body`/`request.query` 生成 mock 数据模板:常规值、边界值(空/超长/非法)、环境变量占位符(双花括号形式,优先用上方默认环境变量里的键)、随机数据用数据工厂占位符(内置 rand.phone/rand.uuid/rand.number:min:max 或自定义 factory.key);2) 直接更新 `test-mode/assets/api/<id>.json` 的 `request` 字段(用 write/edit),不要新建旧 `api/projects/` 结构;3) 这些 mock 数据是**接口资产的参考示例**,工作项 `assets[].data` 覆盖时必须对齐其结构;4) 优先参考 `test-mode/dbdata/` 参考数据(GET /api/dbdata 或直接读 csv/md/xlsx),用真实存在的记录/字段,不要臆造;5) 完成后执行该资产验证(/api/assets/run),失败按报错修正。",
      ].join("\n");
    }

    /** 统一入口:按 kind 组装提示词。 */
    function buildAiPrompt(kind, scope) {
      if (kind === "tags") return buildTagPromptAll(scope);
      if (kind === "mock") return buildMockPrompt(scope);
      return "";
    }

    /**
     * 一键生成按钮的公共逻辑:把提示词填入对话输入框。
     * @param props - 视图组件 props(含 inputActions)。
     * @param kind - 模板类型。
     * @param scope - 模板上下文。
     * @returns 点击处理函数。
     */
    const makeAiClick = (props, kind, scope) => () => {
      const text = buildAiPrompt(kind, scope);
      if (text && props.inputActions?.setDraft) props.inputActions.setDraft(text);
    };

    /** AI 生成按钮:品牌色文字 + tint 底,显眼可点击。 */
    function AiButton(props) {
      const { title, onClick, children, style } = props;
      return react.createElement(Button, {
        onClick,
        title: `${title ?? "AI 生成"}(点击把提示词填入输入框,可补充后发送)`,
        style: { height: 24, padding: "0 10px", font: T.fontXxs, fontWeight: 600, ...style },
        variant: "custom",
      }, children ?? "AI 生成");
    }

    /** 变量提取编辑器:变量名 + path/header + from(json/header) + export(写会话)。 */
    function ExtractEditor(props) {
      const { value, onChange } = props;
      const update = (index, field, next) => {
        const rows = value.map((item, i) => {
          if (i !== index) return item;
          const norm = { name: item.name ?? item.key ?? "", path: item.path ?? item.value ?? "", from: item.from ?? "json", export: item.export === true };
          return { ...norm, [field]: next };
        });
        onChange(rows);
      };
      const add = () => onChange([...value, { name: "", path: "", from: "json", export: false }]);
      const remove = (index) => onChange(value.filter((_, i) => i !== index));
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        value.map((item, index) => {
          const norm = { name: item.name ?? item.key ?? "", path: item.path ?? item.value ?? "", from: item.from ?? "json", export: item.export === true };
          return react.createElement("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center" } },
            react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "变量名(如 TOKEN)", value: norm.name,
              onChange: (e) => update(index, "name", e.target.value) }),
            react.createElement("input", { style: { ...inputStyle, flex: 1.4 }, placeholder: norm.from === "header" ? "响应头名(如 set-cookie)" : "json path ($.token)",
              value: norm.path, onChange: (e) => update(index, "path", e.target.value) }),
            react.createElement("select", { style: { ...inputStyle, width: 80, flex: "none" }, value: norm.from,
              onChange: (e) => update(index, "from", e.target.value) },
              react.createElement("option", { value: "json" }, "JSON"),
              react.createElement("option", { value: "header" }, "Header"),
            ),
            react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 3, font: T.fontXxs, color: T.labelSecondary, cursor: "pointer", whiteSpace: "nowrap" } },
              react.createElement("input", { type: "checkbox", style: { margin: 0, accentColor: T.brand }, checked: norm.export,
                onChange: (e) => update(index, "export", e.target.checked) }),
              "存会话",
            ),
            react.createElement(Button, { onClick: () => remove(index), style: { padding: "0 6px", height: 22 } }, "×"),
          );
        }),
        react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          react.createElement(Button, { onClick: add, style: { alignSelf: "flex-start", height: 22, padding: "0 8px" } }, "+ 添加提取"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            "「存会话」的变量会写入会话缓存,后续执行(集合/用例/计划)自动复用——适合 token/cookie 等登录态"),
        ),
      );
    }

    /** 分区容器:标题行 + 内容。 */
    function Section(props) {      const { title, children, right } = props;
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
          react.createElement("span", { style: { ...fieldLabel, marginBottom: 0 } }, title),
          right ?? null,
        ),
        children,
      );
    }

    /** 空态组件(非测试模式会话打开标签时显示提示页)。 */
    function EmptyView() {
      return react.createElement("div", { style: emptyStyle },
        react.createElement("strong", { style: { font: T.fontXsStrong } }, "测试面板仅在测试模式会话中可用"),
        react.createElement("span", null, "请在会话开始前选择「测试模式」Agent 预设后使用。"),
      );
    }

    // ── 报告图表(阶段 3:手写 inline SVG,无图表库依赖) ───────────────────

    /**
     * 通过率环形图:SVG circle + stroke-dasharray 实现。
     * @param props - { total, passed }。
     */
    function DonutChart(props) {
      const { total, passed } = props;
      const size = 120;
      const stroke = 14;
      const radius = (size - stroke) / 2;
      const circumference = 2 * Math.PI * radius;
      const ratio = total > 0 ? passed / total : 0;
      const dash = circumference * ratio;
      const percent = Math.round(ratio * 100);
      const color = total === 0 ? T.labelTertiary : (ratio === 1 ? T.success : (ratio >= 0.6 ? T.warn : T.error));
      return react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
        react.createElement("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
          react.createElement("circle", {
            cx: size / 2, cy: size / 2, r: radius,
            fill: "none", stroke: T.bgLayer2, strokeWidth: stroke,
          }),
          react.createElement("circle", {
            cx: size / 2, cy: size / 2, r: radius,
            fill: "none", stroke: color, strokeWidth: stroke,
            strokeDasharray: `${dash} ${circumference - dash}`,
            strokeLinecap: "round",
            transform: `rotate(-90 ${size / 2} ${size / 2})`,
          }),
        ),
        react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2 } },
          react.createElement("span", { style: { font: T.fontXl, fontWeight: 600, color: T.labelPrimary } }, `${percent}%`),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `通过率 (${passed}/${total})`),
        ),
      );
    }

    /**
     * 回归趋势折线:同系列报告(同 kind+name)的通过率随时间变化(SVG polyline)。
     * @param props - { points: [{ label, rate }] }(rate 0-100)。
     */
    function TrendChart(props) {
      const { points } = props;
      if ((points ?? []).length < 2) {
        return react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
          "至少需要两次执行才能显示趋势");
      }
      const width = 260;
      const height = 90;
      const pad = 8;
      const maxX = width - pad * 2;
      const maxY = height - pad * 2;
      const x = (i) => pad + (points.length === 1 ? 0 : (i * maxX) / (points.length - 1));
      const y = (rate) => pad + maxY - (Math.max(0, Math.min(100, rate)) / 100) * maxY;
      const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(" ");
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
        react.createElement("svg", { width, height, viewBox: `0 0 ${width} ${height}` },
          // 网格线:0% / 50% / 100%
          [0, 50, 100].map((rate) => react.createElement("line", {
            key: rate,
            x1: pad, y1: y(rate), x2: width - pad, y2: y(rate),
            stroke: T.borderL1, strokeWidth: 1, strokeDasharray: "3 3",
          })),
          react.createElement("polyline", { points: line, fill: "none", stroke: T.brand, strokeWidth: 2 }),
          points.map((p, i) => react.createElement("circle", {
            key: i, cx: x(i), cy: y(p.rate), r: 3,
            fill: p.rate >= 100 ? T.success : (p.rate >= 60 ? T.warn : T.error),
          })),
        ),
        react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          points.map((p, i) => react.createElement(Badge, {
            key: i,
            tone: p.rate >= 100 ? "success" : (p.rate >= 60 ? "warn" : "error"),
          }, `${p.label}: ${p.rate}%`)),
        ),
      );
    }

    /**
     * 水平条形图:每行 label + 值 + 按 max 归一化的色条。
     * @param props - { items: [{ label, value, max, color? }] }。
     */
    function BarChart(props) {
      const { items } = props;
      const max = Math.max(...items.map((i) => i.max ?? i.value ?? 0), 1);
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 } },
        items.map((item, index) => {
          const ratio = max > 0 ? (item.value ?? 0) / max : 0;
          return react.createElement("div", { key: index, style: { display: "flex", flexDirection: "column", gap: 2 } },
            react.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, font: T.fontXxs } },
              react.createElement("span", { style: { color: T.labelSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.label),
              react.createElement("span", { style: { color: T.labelCaption, flex: "none" } }, `${item.value ?? 0}${item.suffix ?? ""}`),
            ),
            react.createElement("div", { style: { height: 6, borderRadius: 3, background: T.bgLayer2, overflow: "hidden" } },
              react.createElement("div", { style: { height: "100%", width: `${Math.max(ratio * 100, item.value > 0 ? 4 : 0)}%`, borderRadius: 3, background: item.color ?? T.brand } }),
            ),
          );
        }),
      );
    }

    // ── 用例管理视图 ──────────────────────────────────────────────────────

    const PRIORITY_TONE = { high: "error", medium: "warn", low: "success" };
    const STATUS_TONE = { draft: "neutral", active: "brand", archived: "neutral" };

    function CaseEditor(props) {
      const { workspaceId, initial, onSaved, onCancel, projects, uiScripts, tags, inputActions } = props;
      // preconditions 兼容两种存储形态:字符串(页面编辑器)或数组(智能体直写)。
      const toPreconditionText = (value) =>
        Array.isArray(value) ? value.join("\n") : (typeof value === "string" ? value : "");
      const [name, setName] = useState(initial?.name ?? "");
      const [description, setDescription] = useState(initial?.description ?? "");
      const [priority, setPriority] = useState(initial?.priority ?? "medium");
      const [preconditions, setPreconditions] = useState(() => toPreconditionText(initial?.preconditions));
      const [steps, setSteps] = useState(initial?.steps ?? [{ action: "", expected: "" }]);
      const [selectedTags, setSelectedTags] = useState((initial?.tags ?? []).filter(Boolean));
      const [status, setStatus] = useState(initial?.status ?? "draft");
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);

      // 绑定请求的三级选项:项目 → 集合 → 请求。
      const requestOptions = [];
      for (const project of projects ?? []) {
        for (const collection of project.collections ?? []) {
          for (const request of collection.requests ?? []) {
            requestOptions.push({
              value: `${project.id}::${collection.id}::${request.id}`,
              label: `${project.name} / ${collection.name} / ${request.name || request.url || request.id}`,
            });
          }
        }
      }
      const refToValue = (ref) =>
        ref && ref.projectId && ref.collectionId && ref.requestId
          ? `${ref.projectId}::${ref.collectionId}::${ref.requestId}`
          : "";

      // 步骤绑定类型:''(手动) / 'api' / 'ui'。
      // 用引用对象是否存在判断(而非其字段值):切换类型后先写入空引用对象
      // 等待选择,空字符串字段是 falsy,若按字段判断会被误认为"手动"。
      const stepBindType = (step) =>
        step.uiRef && typeof step.uiRef === "object"
          ? "ui"
          : (step.requestRef && typeof step.requestRef === "object" ? "api" : "");
      const stepBindValue = (step) => (step.uiRef?.scriptId ? step.uiRef.scriptId : refToValue(step.requestRef));

      const save = async () => {
        setSaving(true); setError(null);
        try {
          const payload = {
            workspaceId, name, description, priority, preconditions,
            steps: steps.map((s) => {
              const base = { action: s.action ?? "", expected: s.expected ?? "" };
              if (s.requestRef && s.requestRef.projectId) base.requestRef = s.requestRef;
              if (s.uiRef && s.uiRef.scriptId) base.uiRef = s.uiRef;
              if (s.data && typeof s.data === "object") base.data = s.data;
              return base;
            }),
            tags: selectedTags,
            status,
          };
          const response = await window.fetch(
            `${ROUTE_ROOT}/api/cases${initial ? `/${initial.id}` : ""}`,
            {
              method: initial ? "PUT" : "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          const data = await response.json();
          if (!response.ok) { setError(data.message ?? `HTTP ${response.status}`); return; }
          onSaved(data.case);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      };

      const updateStep = (index, field, next) => {
        setSteps(steps.map((s, i) => (i === index ? { ...s, [field]: next } : s)));
      };

      // 绑定类型切换:清空另一类引用。
      const updateStepBindType = (index, type) => {
        const step = steps[index];
        if (type === "api") setSteps(steps.map((s, i) => (i === index ? { ...s, uiRef: undefined, requestRef: s.requestRef ?? { projectId: "", collectionId: "", requestId: "" } } : s)));
        else if (type === "ui") setSteps(steps.map((s, i) => (i === index ? { ...s, requestRef: undefined, uiRef: s.uiRef ?? { scriptId: "" } } : s)));
        else setSteps(steps.map((s, i) => (i === index ? { ...s, requestRef: undefined, uiRef: undefined } : s)));
      };

      const updateStepRef = (index, value) => {
        const [projectId, collectionId, requestId] = value.split("::");
        const ref = value ? { projectId, collectionId, requestId } : undefined;
        setSteps(steps.map((s, i) => (i === index ? { ...s, requestRef: ref } : s)));
      };

      const updateStepUiRef = (index, scriptId) => {
        setSteps(steps.map((s, i) => (i === index ? { ...s, uiRef: scriptId ? { scriptId } : undefined } : s)));
      };

      // 步骤级数据覆盖(step.data):KV 编辑器 ↔ 对象转换。
      const stepDataKv = (value) => kvRows(value);
      const stepDataKvTo = (rows) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
      const updateStepData = (index, patch) => {
        const current = steps[index]?.data ?? {};
        updateStep(index, "data", { ...current, ...patch });
      };

      const selectStyle = { ...inputStyle, width: "auto" };

      return react.createElement("div", { style: { ...cardStyle, gap: 14 } },
        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
          react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary, flex: 1 } },
            initial ? "编辑用例" : "新建用例"),
          initial ? react.createElement(AiButton, {
            title: "智能打标(分析用例内容,从标签库推荐标签)",
            onClick: makeAiClick(props, "tag-case", { testCase: initial, tags }),
          }, "AI 生成 · 智能打标") : null,
        ),
        react.createElement(Section, { title: "名称" },
          react.createElement("input", { style: inputStyle, value: name, onChange: (e) => setName(e.target.value) })),
        react.createElement(Section, { title: "描述" },
          react.createElement("textarea", { style: monoStyle, value: description, onChange: (e) => setDescription(e.target.value) })),
        react.createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
          react.createElement("div", null,
            react.createElement("div", { style: fieldLabel }, "优先级"),
            react.createElement("select", { style: selectStyle, value: priority, onChange: (e) => setPriority(e.target.value) },
              ["high", "medium", "low"].map((p) => react.createElement("option", { key: p, value: p }, p))),
          ),
          react.createElement("div", null,
            react.createElement("div", { style: fieldLabel }, "状态"),
            react.createElement("select", { style: selectStyle, value: status, onChange: (e) => setStatus(e.target.value) },
              ["draft", "active", "archived"].map((s) => react.createElement("option", { key: s, value: s }, s))),
          ),
          react.createElement("div", { style: { flex: 1, minWidth: 200 } },
            react.createElement("div", { style: fieldLabel }, "标签(点击选择,只能选标签库中的)"),
            (tags ?? []).length === 0 && selectedTags.length === 0
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                "(标签库为空,可在「基础配置」页添加)")
              : react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                [...new Set([...(tags ?? []), ...selectedTags])].sort().map((tag) => {
                  const selected = selectedTags.includes(tag);
                  const inLibrary = (tags ?? []).includes(tag);
                  return react.createElement("div", {
                    key: tag,
                    role: "button",
                    tabIndex: 0,
                    title: inLibrary ? "点击切换" : "不在标签库,保存会被拒绝;去掉该标签或在「基础配置」页添加",
                    onClick: () => setSelectedTags(selected ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag]),
                    style: {
                      display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px",
                      borderRadius: 6, cursor: "pointer", font: T.fontXxs, fontWeight: 500, whiteSpace: "nowrap",
                      border: `1px solid ${selected ? T.brand : T.borderL2}`,
                      background: selected ? T.brandTint : "transparent",
                      color: selected ? T.brand : (inLibrary ? T.labelSecondary : T.warn),
                    },
                  }, `${tag}${selected ? " ✓" : ""}`);
                }),
              ),
          ),
        ),
        react.createElement(Section, { title: "前置条件" },
          react.createElement("textarea", { style: monoStyle, value: preconditions, onChange: (e) => setPreconditions(e.target.value) })),
        react.createElement(Section, {
          title: "步骤",
          right: react.createElement(Button, { onClick: () => setSteps([...steps, { action: "", expected: "" }]), style: { height: 22, padding: "0 8px" } }, "+ 添加步骤"),
        },
          steps.map((step, index) => react.createElement("div", { key: index, style: { display: "flex", flexDirection: "column", gap: 4 } },
            react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
              react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: "none", width: 18 } }, `${index + 1}`),
              react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "操作", value: step.action ?? "",
                onChange: (e) => updateStep(index, "action", e.target.value) }),
              react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "预期结果", value: step.expected ?? "",
                onChange: (e) => updateStep(index, "expected", e.target.value) }),
              react.createElement(Button, { onClick: () => setSteps(steps.filter((_, i) => i !== index)), style: { padding: "0 6px", height: 22 } }, "×"),
            ),
            react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", paddingLeft: 24 } },
              react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: "none" } }, "绑定:"),
              react.createElement("select", {
                style: { ...inputStyle, width: 90, flex: "none", font: T.fontXxs },
                value: stepBindType(step),
                onChange: (e) => updateStepBindType(index, e.target.value),
              },
                react.createElement("option", { value: "" }, "手动"),
                react.createElement("option", { value: "api" }, "API 请求"),
                react.createElement("option", { value: "ui" }, "UI 脚本"),
              ),
              stepBindType(step) === "api"
                ? react.createElement("select", {
                    style: { ...inputStyle, flex: 1, font: T.fontXxs },
                    value: refToValue(step.requestRef),
                    onChange: (e) => updateStepRef(index, e.target.value),
                  },
                    react.createElement("option", { value: "" }, "(选择 API 请求)"),
                    requestOptions.map((opt) => react.createElement("option", { key: opt.value, value: opt.value }, opt.label)),
                  )
                : stepBindType(step) === "ui"
                  ? react.createElement("select", {
                      style: { ...inputStyle, flex: 1, font: T.fontXxs },
                      value: step.uiRef?.scriptId ?? "",
                      onChange: (e) => updateStepUiRef(index, e.target.value),
                    },
                      react.createElement("option", { value: "" }, "(选择 UI 脚本)"),
                      (uiScripts ?? []).map((script) => react.createElement("option", { key: script.id, value: script.id }, script.name)),
                    )
                  : react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "(手动步骤,执行时跳过)"),
            ),
            stepBindType(step) === "api"
              ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, paddingLeft: 24 } },
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelTertiary } },
                    "数据覆盖(可选):覆盖所绑请求的数据,未填的字段回退接口示例数据"),
                  react.createElement("input", {
                    style: { ...inputStyle, font: T.fontMono, fontSize: 11 },
                    placeholder: "URL 覆盖(可选,默认用请求配置)",
                    value: step.data?.url ?? "",
                    onChange: (e) => updateStepData(index, { url: e.target.value }),
                  }),
                  react.createElement("textarea", {
                    style: { ...monoStyle, minHeight: 48 },
                    placeholder: "Body 覆盖(可选,JSON 或原始文本;支持 {VAR}/rand/factory 占位符)",
                    value: typeof step.data?.body === "string" ? step.data.body : (step.data?.body ? JSON.stringify(step.data.body, null, 2) : ""),
                    onChange: (e) => {
                      const text = e.target.value;
                      let body = text;
                      if (text.trim()) {
                        try { body = JSON.parse(text); } catch { body = text; }
                      }
                      updateStepData(index, { body });
                    },
                  }),
                  react.createElement(KeyValueEditor, {
                    value: stepDataKv(step.data?.query),
                    onChange: (rows) => updateStepData(index, { query: stepDataKvTo(rows) }),
                    keyPlaceholder: "query 参数",
                    valuePlaceholder: "值(支持占位符)",
                  }),
                  react.createElement(KeyValueEditor, {
                    value: stepDataKv(step.data?.headers),
                    onChange: (rows) => updateStepData(index, { headers: stepDataKvTo(rows) }),
                    keyPlaceholder: "header",
                    valuePlaceholder: "值(支持占位符)",
                  }),
                )
              : null,
          )),
        ),
        error ? react.createElement("div", { style: { color: T.error, font: T.fontXxs } }, error) : null,
        react.createElement("div", { style: { display: "flex", gap: 8 } },
          react.createElement(Button, { variant: "primary", onClick: () => void save(), disabled: saving },
            saving ? "保存中…" : "保存"),
          react.createElement(Button, { onClick: onCancel }, "取消"),
        ),
      );
    }

    function CasesView(props) {
      // 标准 props 无 workspaceId:从 useWorkspaces 按当前会话推导
      // (与 ui-design 同法:工作区 = 包含当前 sessionId 的那个)。
      // hook 必须无条件调用:可选链短路会让 React 检测到 hook 数量变化而
      // 卸载整个组件树(空白页)。
      const sessionId = props.sessionId;
      const workspace = props.useWorkspaces((state) =>
        state.items.find((item) => item.sessionIds?.includes(sessionId)),
      );
      const workspaceId = workspace?.workspaceId ?? null;
      const [cases, setCases] = useState([]);
      const [projects, setProjects] = useState([]);
      const [uiScripts, setUiScripts] = useState([]);
      const [environments, setEnvironments] = useState([]);
      const [tags, setTags] = useState([]);
      const [selectedEnvId, setSelectedEnvId] = useState("");
      const [loading, setLoading] = useState(true);
      const [editing, setEditing] = useState(null); // null=列表, {}=新建, {case}=编辑
      const [running, setRunning] = useState(null); // 正在执行的用例 id
      const [caseResult, setCaseResult] = useState(null); // 用例执行报告
      const [error, setError] = useState(null);
      const [confirm, setConfirm] = useState(null); // { message, onConfirm } 删除确认
      // 筛选(阶段 2):关键字 / 优先级 / 状态 / 标签 / 显示归档
      const [keyword, setKeyword] = useState("");
      const [filterPriority, setFilterPriority] = useState("");
      const [filterStatus, setFilterStatus] = useState("");
      const [filterTag, setFilterTag] = useState("");
      const [showArchived, setShowArchived] = useState(false);

      // 全部标签(用于筛选下拉,来自当前用例集合)。
      const allTags = [...new Set((cases ?? []).flatMap((c) => c.tags ?? []))].sort();
      // 过滤后的用例:关键字命中名称/描述/标签;优先级/状态精确;归档默认隐藏。
      const visibleCases = (cases ?? []).filter((c) => {
        if (!showArchived && c.status === "archived") return false;
        if (filterPriority && c.priority !== filterPriority) return false;
        if (filterStatus && c.status !== filterStatus) return false;
        if (filterTag && !(c.tags ?? []).includes(filterTag)) return false;
        if (keyword) {
          const haystack = `${c.name ?? ""} ${c.description ?? ""} ${(c.tags ?? []).join(" ")}`.toLowerCase();
          if (!haystack.includes(keyword.toLowerCase())) return false;
        }
        return true;
      });

      const refresh = async () => {
        setLoading(true);
        try {
          const [c, p, u, e, t] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/cases?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/ui/scripts?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/tags?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
          ]);
          if (c.ok) setCases(c.cases ?? []);
          else setError(c.message);
          if (p.ok) setProjects(p.projects ?? []);
          if (t.ok) setTags(t.tags ?? []);
          if (u.ok) setUiScripts(u.scripts ?? []);
          if (e.ok) setEnvironments(e.environments ?? []);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => { if (workspaceId) void refresh(); }, [workspaceId]);

      const remove = (caseItem) => {
        setConfirm({
          message: `删除用例「${caseItem.name}」?`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/cases/${caseItem.id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) void refresh();
            else setError(data.message);
          },
        });
      };

      const runCase = async (caseItem) => {
        setRunning(caseItem.id); setCaseResult(null); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/cases/${caseItem.id}/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, environmentId: selectedEnvId }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setCaseResult(data.report);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setRunning(null);
        }
      };

      const boundSteps = (caseItem) =>
        (caseItem.steps ?? []).filter((s) => (s.requestRef && s.requestRef.projectId) || (s.uiRef && s.uiRef.scriptId)).length;

      if (editing !== null) {
        return react.createElement("div", { style: rootStyle },
          react.createElement("div", { style: toolbarStyle },
            react.createElement(Button, { onClick: () => setEditing(null) }, "← 返回列表"),
            react.createElement("span", { style: toolbarTitle }, editing.case ? "编辑用例" : "新建用例"),
          ),
          react.createElement("div", { style: scrollStyle },
            react.createElement("div", { style: contentColumn },
              react.createElement(CaseEditor, {
                workspaceId, initial: editing.case ?? undefined, projects, uiScripts, tags,
                inputActions: props.inputActions,
                onSaved: () => { setEditing(null); void refresh(); },
                onCancel: () => setEditing(null),
              }),
            ),
          ),
        );
      }

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          react.createElement("span", { style: toolbarTitle }, "测试用例"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            visibleCases.length !== (cases ?? []).length ? `${visibleCases.length}/${cases.length}` : `${cases.length}`),
          react.createElement("span", { style: toolbarSpacer }),
          react.createElement(AiButton, {
            title: "基于业务场景生成测试用例(接口自动融入用例步骤;点击后在输入框补充场景清单或文档位置)",
            onClick: makeAiClick(props, "cases", { projects, tags }),
          }, "AI 生成 · 场景用例"),
          react.createElement(AiButton, {
            title: "给存量用例的步骤批量补齐 requestRef 绑定,接通用例↔接口覆盖图谱(迭代增量反查依赖它)",
            onClick: makeAiClick(props, "bind-refs", { cases, projects }),
          }, "AI 生成 · 智能绑定接口"),
          react.createElement("select", { style: { ...inputStyle, width: "auto" }, value: selectedEnvId,
            title: "执行用例时使用的环境(未选则用默认环境)",
            onChange: (e) => setSelectedEnvId(e.target.value) },
            react.createElement("option", { value: "" }, "(默认环境)"),
            environments.map((env) => react.createElement("option", { key: env.id, value: env.id }, env.name))),
          react.createElement(Button, { variant: "primary", onClick: () => setEditing({}) }, "+ 新建用例"),
        ),
        // 筛选栏(阶段 2)
        react.createElement("div", { style: {
          display: "flex", flex: "none", alignItems: "center", gap: 8,
          boxSizing: "border-box", width: "100%", padding: "8px 16px",
          borderBottom: `1px solid ${T.borderL1}`, background: T.bgLayer1,
        } },
          react.createElement("input", {
            style: { ...inputStyle, flex: 1, minWidth: 120, font: T.fontXxs },
            placeholder: "搜索名称 / 描述 / 标签…",
            value: keyword,
            onChange: (e) => setKeyword(e.target.value),
          }),
          react.createElement("select", { style: { ...inputStyle, width: "auto", font: T.fontXxs }, value: filterPriority,
            onChange: (e) => setFilterPriority(e.target.value) },
            react.createElement("option", { value: "" }, "优先级:全部"),
            ["high", "medium", "low"].map((p) => react.createElement("option", { key: p, value: p }, p)),
          ),
          react.createElement("select", { style: { ...inputStyle, width: "auto", font: T.fontXxs }, value: filterStatus,
            onChange: (e) => setFilterStatus(e.target.value) },
            react.createElement("option", { value: "" }, "状态:全部"),
            ["draft", "active", "archived"].map((s) => react.createElement("option", { key: s, value: s }, s)),
          ),
          react.createElement("select", { style: { ...inputStyle, width: "auto", maxWidth: 140, font: T.fontXxs }, value: filterTag,
            onChange: (e) => setFilterTag(e.target.value) },
            react.createElement("option", { value: "" }, "标签:全部"),
            allTags.map((t) => react.createElement("option", { key: t, value: t }, t)),
          ),
          react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, font: T.fontXxs, color: T.labelSecondary, cursor: "pointer" } },
            react.createElement("input", { type: "checkbox", style: { margin: 0, accentColor: T.brand }, checked: showArchived,
              onChange: (e) => setShowArchived(e.target.checked) }),
            "显示归档",
          ),
        ),
        react.createElement("div", { style: scrollStyle },
          error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
          loading ? react.createElement("div", { style: emptyStyle }, "加载中…")
            : (cases ?? []).length === 0 ? react.createElement("div", { style: emptyStyle }, "还没有用例,点击「新建用例」开始")
            : visibleCases.length === 0 ? react.createElement("div", { style: emptyStyle }, "没有匹配筛选条件的用例")
            : react.createElement("div", { style: contentColumn },
              visibleCases.map((caseItem) => react.createElement("div", { key: caseItem.id, style: cardStyle },
                react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 } },
                  react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 } },
                    react.createElement("strong", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, caseItem.name),
                    caseItem.description
                      ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelTertiary, lineHeight: "1.5", wordBreak: "break-word" } }, caseItem.description)
                      : null,
                  ),
                  react.createElement("div", { style: { display: "flex", gap: 5, flex: "none", flexWrap: "wrap", justifyContent: "flex-end" } },
                    react.createElement(Badge, { tone: PRIORITY_TONE[caseItem.priority] ?? "neutral" }, caseItem.priority ?? "medium"),
                    react.createElement(Badge, { tone: STATUS_TONE[caseItem.status] ?? "neutral" }, caseItem.status ?? "draft"),
                    (caseItem.tags ?? []).slice(0, 4).map((tag) => react.createElement(Badge, { key: tag }, tag)),
                  ),
                ),
                react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                    `${(caseItem.steps ?? []).length} 个步骤`),
                  boundSteps(caseItem) > 0
                    ? react.createElement(Badge, { tone: "brand" }, `${boundSteps(caseItem)} 个绑定请求`)
                    : null,
                  react.createElement("span", { style: { flex: 1 } }),
                  boundSteps(caseItem) > 0
                    ? react.createElement(Button, { variant: "primary", onClick: () => void runCase(caseItem), disabled: running !== null },
                      running === caseItem.id ? "执行中…" : "执行")
                    : null,
                  react.createElement(Button, { onClick: () => setEditing({ case: caseItem }) }, "编辑"),
                  react.createElement(AiButton, {
                    title: "AI 完善该用例(补全步骤/绑定接口/打标,点击后提示词填入输入框)",
                    onClick: makeAiClick(props, "case-improve", { testCase: caseItem, projects, tags }),
                    style: { height: 22, padding: "0 8px", font: T.fontXxs, fontWeight: 600 },
                  }),
                  react.createElement(Button, { variant: "danger", onClick: () => void remove(caseItem) }, "删除"),
                ),
              )),
              // 用例执行结果(全局一次一份,展示在列表底部)
              caseResult ? react.createElement("div", { style: { ...cardStyle, gap: 6, borderColor: caseResult.summary?.failed > 0 ? T.error : T.success } },
                react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                  react.createElement("span", { style: { font: T.fontXsStrong } }, `用例执行: ${caseResult.name}`),
                  react.createElement(Badge, { tone: caseResult.summary?.failed > 0 ? "error" : "success" },
                    `${caseResult.summary?.passed ?? 0}/${caseResult.summary?.total ?? 0} 通过`),
                  react.createElement(Badge, null, `跳过 ${caseResult.summary?.skipped ?? 0}`),
                  react.createElement(Badge, null, `${(caseResult.durationMs ?? 0).toFixed(0)}ms`),
                  react.createElement("span", { style: { flex: 1 } }),
                  react.createElement(Button, { onClick: () => setCaseResult(null), style: { height: 20, padding: "0 6px" } }, "关闭"),
                ),
                (caseResult.results ?? []).map((entry, i) => react.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 8, font: T.fontXxs } },
                  react.createElement("span", { style: { flex: "none", width: 16, color: entry.skipped ? T.labelCaption : (entry.pass ? T.success : T.error), fontWeight: 700 } },
                    entry.skipped ? "–" : (entry.pass ? "✓" : "✗")),
                  react.createElement("span", { style: { color: T.labelSecondary, flex: "none", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                    `步骤 ${entry.stepIndex + 1}: ${entry.step?.action ?? ""}`),
                  entry.skipped
                    ? react.createElement("span", { style: { color: T.labelCaption } }, entry.error ?? "未绑定请求,跳过")
                    : react.createElement("span", { style: { color: T.labelCaption, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      `${entry.method ?? ""} ${entry.url ?? ""} · ${(entry.durationMs ?? 0).toFixed(0)}ms`),
                )),
              ) : null,
            ),
        ),
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
      );
    }

    // ── API 测试视图 ──────────────────────────────────────────────────────

    const REQUEST_DEFAULTS = { name: "", method: "GET", url: "", headers: [], query: [], body: "", assertions: [], extract: [] };

    const METHOD_COLOR = {
      GET: { color: T.success, background: T.successTint },
      POST: { color: T.brand, background: T.brandTint },
      PUT: { color: T.warn, background: T.warnTint },
      PATCH: { color: T.warn, background: T.warnTint },
      DELETE: { color: T.error, background: T.errorTint },
      HEAD: { color: T.labelSecondary, background: T.bgLayer2 },
    };

    function MethodBadge(props) {
      const { method } = props;
      const tone = METHOD_COLOR[String(method ?? "GET").toUpperCase()] ?? METHOD_COLOR.GET;
      return react.createElement("span", {
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
          width: 52,
          height: 20,
          borderRadius: 5,
          font: T.fontXxs,
          fontWeight: 700,
          letterSpacing: "0.02em",
          ...tone,
        },
      }, String(method ?? "GET").toUpperCase());
    }

    /**
     * 数据工厂小卡片:名称 + token,点击弹出详情。
     * 内置生成器默认样式;自定义生成器品牌色边框 + ✦ 标记。
     */
    function FactoryCard(props) {
      const { gen, onClick } = props;
      const [hovered, setHovered] = useState(false);
      const custom = !gen.builtin;
      const token = custom ? `{{factory.${gen.key}}}` : gen.pattern;
      const style = {
        display: "flex",
        flexDirection: "column",
        gap: 2,
        boxSizing: "border-box",
        width: 118,
        minHeight: 44,
        padding: "6px 8px",
        borderRadius: 6,
        cursor: "pointer",
        border: `1px solid ${custom ? T.brand : T.borderL2}`,
        background: custom ? (hovered ? T.brandTint : T.bgLayer2) : (hovered ? T.hover : T.bgLayer2),
      };
      return react.createElement("div", {
        role: "button",
        tabIndex: 0,
        title: "点击查看详情",
        style,
        onClick,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
      },
        react.createElement("span", { style: { font: T.fontXxs, fontWeight: 600, color: T.labelPrimary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
          `${gen.name || gen.key}${custom ? " ✦" : ""}`),
        react.createElement("span", { style: { font: T.fontMono, fontSize: 10, color: custom ? T.brand : T.labelTertiary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
          token),
      );
    }

    /**
     * 数据工厂详情弹窗:名称/类型/token/描述 + 示例预览(调用后端
     * /api/datafactory/preview)。操作按钮按传入的 onXxx 可选显示:
     * 插入到 Body(API 编辑器) / 编辑 / 删除(数据工厂页面,仅自定义)。
     */
    function FactoryDetailDialog(props) {
      const { gen, workspaceId, onInsert, onEdit, onDelete, onClose } = props;
      const custom = !gen.builtin;
      const token = custom ? `{{factory.${gen.key}}}` : gen.pattern;
      const [samples, setSamples] = useState(null); // null=加载中, [] = 无/失败
      useEffect(() => {
        let alive = true;
        setSamples(null);
        window.fetch(`${ROUTE_ROOT}/api/datafactory/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, pattern: token, count: 3 }),
        })
          .then((res) => res.json())
          .then((data) => { if (alive) setSamples(data.ok ? (data.samples ?? []) : []); })
          .catch(() => { if (alive) setSamples([]); });
        return () => { alive = false; };
      }, [gen.id]);
      return react.createElement("div", { style: overlayStyle, onClick: onClose },
        react.createElement("div", { style: { ...dialogCardStyle, width: 380 }, onClick: (e) => e.stopPropagation() },
          react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              gen.name || gen.key),
            react.createElement(Badge, { tone: custom ? "brand" : "success" }, custom ? "自定义" : "内置"),
          ),
          react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
            react.createElement("span", { style: { font: T.fontMono, fontSize: 12, color: T.labelSecondary, wordBreak: "break-all" } }, token),
            gen.builtin && gen.description
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelTertiary } }, gen.description)
              : null,
          ),
          !gen.builtin && gen.pattern
            ? react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: "none" } }, "模板:"),
                react.createElement("span", { style: { font: T.fontMono, fontSize: 11, color: T.labelTertiary, wordBreak: "break-all" } }, gen.pattern),
              )
            : null,
          react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: "none" } }, "示例:"),
            samples === null
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "生成中…")
              : samples.length === 0
                ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "(无法生成示例)")
                : samples.map((sample, i) => react.createElement(Badge, { key: i, tone: "brand" }, sample)),
          ),
          react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            onEdit ? react.createElement(Button, { onClick: onEdit }, "编辑") : null,
            onDelete ? react.createElement(Button, { variant: "danger", onClick: onDelete }, "删除") : null,
            react.createElement(Button, { onClick: onClose }, "关闭"),
            onInsert ? react.createElement(Button, { variant: "primary", onClick: () => onInsert(token) }, "插入到 Body") : null,
          ),
        ),
      );
    }

    function RequestEditor(props) {
      const { request, onChange, onRun, onRunCollection, running, generators, project, collectionId } = props;
      const r = { ...REQUEST_DEFAULTS, ...request };
      const appendFactoryToken = (token) => {
        const sep = r.body && r.body.trim() ? (r.body.trimEnd().endsWith(",") ? "\n" : ",\n") : "";
        onChange({ ...r, body: `${r.body ?? ""}${sep}${token}` });
      };
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          react.createElement("select", { style: { ...inputStyle, width: 96, flex: "none" }, value: r.method,
            onChange: (e) => onChange({ ...r, method: e.target.value }) },
            ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => react.createElement("option", { key: m, value: m }, m))),
          react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "请求名称", value: r.name,
            onChange: (e) => onChange({ ...r, name: e.target.value }) }),
        ),
        react.createElement("input", { style: { ...inputStyle, font: T.fontMono }, placeholder: "URL(相对路径拼接 baseUrl,或绝对 URL)", value: r.url,
          onChange: (e) => onChange({ ...r, url: e.target.value }) }),
        react.createElement(Section, { title: "Headers" },
          react.createElement(KeyValueEditor, { value: kvRows(r.headers), onChange: (headers) => onChange({ ...r, headers: kvObj(headers) }) })),
        react.createElement(Section, { title: "Query" },
          react.createElement(KeyValueEditor, { value: kvRows(r.query), onChange: (query) => onChange({ ...r, query: kvObj(query) }) })),
        react.createElement(Section, {
          title: "Body(JSON 或原始文本)",
          right: react.createElement(AiButton, {
            title: `为本接口「${r.name || r.url || r.id}」生成 mock 测试数据`,
            onClick: makeAiClick(props, "mock", { asset: props.asset, projects: project ? [project] : [], env: props.env }),
          }, "AI 生成 · 本接口 mock"),
        },
          react.createElement("textarea", { style: { ...monoStyle, minHeight: 80 }, value: r.body,
            onChange: (e) => onChange({ ...r, body: e.target.value }) }),
          // 数据工厂:内置 + 用户自定义生成器(单一来源 = 后端 /api/datafactory
          // 合并列表),点击把 token 追加到 body
          react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 } },
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
              "数据工厂:点击插入生成器 token(执行时动态生成随机数据,也可用于 URL/Header)"),
            react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
              (generators ?? []).map((gen) => react.createElement(Button, {
                key: gen.id,
                title: gen.builtin
                  ? `${gen.pattern ?? ""}: ${gen.description ?? ""}`
                  : `{{factory.${gen.key}}}: ${gen.description || gen.pattern || ""}`,
                onClick: () => appendFactoryToken(gen.builtin ? gen.pattern : `{{factory.${gen.key}}}`),
                style: { height: 22, padding: "0 8px", font: T.fontXxs },
                variant: gen.builtin ? "default" : "custom",
              }, gen.builtin ? (gen.name ?? gen.key) : `${gen.name || gen.key} ✦`)),
            ),
            (generators ?? []).some((gen) => !gen.builtin)
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                "✦ = 自定义生成器(在「基础配置 → 数据工厂」中配置)")
              : null,
          ),
        ),
        react.createElement(Section, { title: "断言" },
          react.createElement(AssertionEditor, { value: r.assertions, onChange: (assertions) => onChange({ ...r, assertions }) })),
        react.createElement(Section, { title: "变量提取(响应 → 后续请求)" },
          react.createElement(ExtractEditor, { value: r.extract, onChange: (extract) => onChange({ ...r, extract }) })),
        react.createElement("div", { style: { display: "flex", gap: 8 } },
          react.createElement(Button, { variant: "primary", onClick: () => onRun(r), disabled: running },
            running ? "执行中…" : "执行请求"),
          react.createElement(Button, { onClick: onRunCollection, disabled: running }, "执行整个集合"),
        ),
      );
    }

    function ApiTestView(props) {
      const sessionId = props.sessionId;
      const embedded = props.embedded === true;
      const workspace = props.useWorkspaces((state) =>
        state.items.find((item) => item.sessionIds?.includes(sessionId)),
      );
      const workspaceId = workspace?.workspaceId ?? null;
      const [projects, setProjects] = useState([]);
      const [environments, setEnvironments] = useState([]);
      const [defaultEnvId, setDefaultEnvId] = useState("");
      const [generators, setGenerators] = useState([]);
      const [tags, setTags] = useState([]);
      const [selectedProjectId, setSelectedProjectId] = useState(null);
      const [selectedCollectionId, setSelectedCollectionId] = useState(null);
      const [selectedRequestId, setSelectedRequestId] = useState(null);
      const [selectedEnvId, setSelectedEnvId] = useState("");
      const [draft, setDraft] = useState(null); // 正在编辑的请求
      const [result, setResult] = useState(null);
      const [error, setError] = useState(null);
      const [running, setRunning] = useState(false);
      // OpenAPI 导入面板(阶段 2)
      const [importOpen, setImportOpen] = useState(false);
      const [importName, setImportName] = useState("");
      const [importSpec, setImportSpec] = useState("");
      const [importing, setImporting] = useState(false);
      const [confirm, setConfirm] = useState(null); // { message, onConfirm } 删除确认
      const [prompt, setPrompt] = useState(null); // { title, initial, onConfirm } 新建名称

      const doImport = async () => {
        setImporting(true); setError(null);
        try {
          const spec = JSON.parse(importSpec);
          const response = await window.fetch(`${ROUTE_ROOT}/api/import/openapi`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, name: importName || undefined, spec }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setImportOpen(false); setImportName(""); setImportSpec("");
          setSelectedProjectId(data.project.id);
          setSelectedCollectionId(null); setSelectedRequestId(null); setDraft(null);
          void refreshAll();
        } catch (e) {
          setError(e instanceof Error && e.message.includes("JSON") ? "OpenAPI spec 不是合法 JSON: " + e.message : (e instanceof Error ? e.message : String(e)));
        } finally {
          setImporting(false);
        }
      };

      const refreshAll = async () => {
        try {
          const [p, e, f, t] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/datafactory?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/tags?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
          ]);
          if (p.ok) setProjects(p.projects ?? []);
          if (e.ok) { setEnvironments(e.environments ?? []); setDefaultEnvId(e.defaultEnvironmentId ?? ""); }
          if (f.ok) setGenerators(f.generators ?? []);
          if (t.ok) setTags(t.tags ?? []);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      };

      useEffect(() => { if (workspaceId) void refreshAll(); }, [workspaceId]);

      const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
      const selectedCollection = selectedProject?.collections?.find((c) => (c.id ?? c.name) === selectedCollectionId) ?? null;
      const selectedRequest = selectedCollection?.requests?.find((r) => (r.id ?? r.name) === selectedRequestId) ?? null;

      // 请求 → 后端格式(键值对数组/对象 → 对象,body 字符串 → 尝试解析 JSON)
      const normalizeRequest = (raw) => ({
        id: raw.id, name: raw.name, method: raw.method, url: raw.url,
        headers: kvObj(raw.headers),
        query: kvObj(raw.query),
        body: (() => {
          const text = raw.body ?? "";
          if (!text.trim()) return undefined;
          try { return JSON.parse(text) } catch { return text }
        })(),
        assertions: (raw.assertions ?? []).map((a) => ({ ...a, expected: a.expected === "" ? undefined : a.expected })),
        extract: (raw.extract ?? []).filter((h) => h.key).map((h) => ({ name: h.key, path: h.value })),
      });

      const saveRequest = async (request) => {
        if (!selectedProject || !selectedCollection) return;
        const normalized = normalizeRequest(request);
        const collections = selectedProject.collections.map((c) => {
          if (c.id !== selectedCollection.id) return c;
          const exists = c.requests?.some((r) => r.id === request.id);
          const requests = exists
            ? c.requests.map((r) => (r.id === request.id ? { ...r, ...normalized } : r))
            : [...(c.requests ?? []), { ...normalized, id: request.id ?? `req-${Date.now()}` }];
          return { ...c, requests };
        });
        const response = await window.fetch(`${ROUTE_ROOT}/api/projects/${selectedProject.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, ...selectedProject, collections }),
        });
        const data = await response.json();
        if (!data.ok) { setError(data.message); return }
        setSelectedRequestId(request.id);
        void refreshAll();
      };

      const addProject = () => {
        setPrompt({
          title: "新建项目",
          initial: "新项目",
          onConfirm: async (name) => {
            setPrompt(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/projects`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId, name, requireSecurity }),
            });
            const data = await response.json();
            if (data.ok) { setSelectedProjectId(data.project.id); void refreshAll(); }
            else setError(data.message);
          },
        });
      };

      const addCollection = () => {
        if (!selectedProject) return;
        setPrompt({
          title: "新建集合",
          initial: "新集合",
          onConfirm: async (name) => {
            setPrompt(null);
            const collections = [...(selectedProject.collections ?? []), { id: `col-${Date.now()}`, name, requests: [] }];
            const response = await window.fetch(`${ROUTE_ROOT}/api/projects/${selectedProject.id}`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId, ...selectedProject, collections }),
            });
            const data = await response.json();
            if (data.ok) { setSelectedCollectionId(collections[collections.length - 1].id); void refreshAll(); }
            else setError(data.message);
          },
        });
      };

      const addRequest = () => {
        if (!selectedCollection) return;
        setDraft({ id: `req-${Date.now()}`, ...REQUEST_DEFAULTS });
      };

      const deleteProject = () => {
        if (!selectedProject) return;
        setConfirm({
          message: `删除项目「${selectedProject.name}」?项目下的集合与请求会一并删除。`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/projects/${selectedProject.id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) { setSelectedProjectId(null); setSelectedCollectionId(null); setSelectedRequestId(null); void refreshAll(); }
            else setError(data.message);
          },
        });
      };

      const runRequest = async (request) => {
        if (!selectedProject) return;
        setRunning(true); setResult(null); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/run-request`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, environmentId: selectedEnvId, baseUrl: selectedProject.baseUrl, projectId: selectedProject.id, collectionId: selectedCollection.id, request: normalizeRequest(request) }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setResult(data.result);
          await saveRequest(request);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setRunning(false);
        }
      };

      const runCollection = async () => {
        if (!selectedProject || !selectedCollection) return;
        setRunning(true); setResult(null); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/run-collection`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, environmentId: selectedEnvId, projectId: selectedProject.id, collectionId: selectedCollection.id }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setResult({ collectionReport: data.report });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setRunning(false);
        }
      };

      const editingRequest = draft ?? selectedRequest ?? null;

      // 缺口分析:所有接口 + 从未测试或最后失败的接口。
      const allRequests = projects.flatMap((project) =>
        (project.collections ?? []).flatMap((collection) =>
          (collection.requests ?? []).map((request) => ({
            projectName: project.name,
            collectionName: collection.name,
            requestName: request.name || request.url || request.id,
            method: request.method ?? "GET",
            url: request.url ?? "",
            lastRun: request.lastRun,
          })),
        ),
      );
      const gaps = allRequests.filter((request) => !request.lastRun || request.lastRun.pass !== true);

      // 默认环境变量(供 mock 提示词使用)。
      const defaultEnvVariables = environments.find((env) => env.id === defaultEnvId)?.variables ?? {};

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          embedded ? null : react.createElement("span", { style: toolbarTitle }, "API 测试"),
          react.createElement("span", { style: toolbarSpacer }),
          react.createElement(AiButton, {
            title: "对所有接口生成 mock 测试数据",
            onClick: makeAiClick(props, "mock", { projects, target: undefined, tags, env: defaultEnvVariables }),
          }, "AI 生成 · 全部 mock"),
          react.createElement(AiButton, {
            title: `对未测试通过/从未测试的接口生成 mock(当前 ${gaps.length} 个缺口)`,
            onClick: makeAiClick(props, "gap-mock", { projects, gaps, env: defaultEnvVariables }),
          }, "AI 生成 · 缺口 mock"),
          react.createElement("select", { style: { ...inputStyle, width: "auto" }, value: selectedEnvId,
            title: "执行请求时使用的环境(未选则用默认环境)",
            onChange: (e) => setSelectedEnvId(e.target.value) },
            react.createElement("option", { value: "" }, "(默认环境)"),
            environments.map((env) => react.createElement("option", { key: env.id, value: env.id }, env.name))),
          react.createElement(Button, { onClick: () => void addProject() }, "+ 项目"),
          react.createElement(Button, { onClick: () => setImportOpen(!importOpen) },
            importOpen ? "收起导入" : "导入 OpenAPI"),
          selectedProject ? react.createElement(Button, { variant: "danger", onClick: () => void deleteProject() }, "删项目") : null,
        ),
        error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
        // OpenAPI 导入面板(阶段 2)
        importOpen ? react.createElement("div", { style: {
          flex: "none", boxSizing: "border-box", padding: "10px 16px",
          borderBottom: `1px solid ${T.borderL2}`, background: T.bgLayer2,
          display: "flex", flexDirection: "column", gap: 8,
        } },
          react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
            react.createElement("span", { style: { font: T.fontXsStrong } }, "导入 OpenAPI 3.x"),
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "粘贴 JSON 格式的 spec(OpenAPI 3.0/3.1),按 operation tag 分组生成项目集合"),
          ),
          react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            react.createElement("input", { style: { ...inputStyle, width: 200 }, placeholder: "项目名称(默认取 info.title)", value: importName,
              onChange: (e) => setImportName(e.target.value) }),
            react.createElement(Button, { variant: "primary", onClick: () => void doImport(), disabled: importing || !importSpec.trim() },
              importing ? "导入中…" : "导入"),
          ),
          react.createElement("textarea", {
            style: { ...monoStyle, minHeight: 140, maxHeight: 220 },
            placeholder: '{\n  "openapi": "3.0.3",\n  "info": { "title": "订单服务" },\n  "servers": [{ "url": "https://api.example.com" }],\n  "paths": { "/orders": { "get": { "operationId": "listOrders", "tags": ["订单"] } } }\n}',
            value: importSpec,
            onChange: (e) => setImportSpec(e.target.value),
          }),
        ) : null,
        projects.length === 0
          ? react.createElement("div", { style: emptyStyle }, "还没有 API 项目,点击「+ 项目」开始")
          : react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", gap: 0, overflow: "hidden" } },
            // 左列:项目/集合/请求树
            react.createElement("div", { style: {
              flex: "0 0 240px", minHeight: 0, display: "flex", flexDirection: "column",
              boxSizing: "border-box", padding: "10px 8px", overflowY: "auto",
              borderRight: `1px solid ${T.borderL2}`, background: T.bgLayer2,
            } },
              projects.map((project) => react.createElement("div", { key: project.id, style: { display: "flex", flexDirection: "column", gap: 2 } },
                react.createElement(Row, {
                  selected: project.id === selectedProjectId,
                  onClick: () => {
                    if (project.id === selectedProjectId) {
                      // 已展开 → 收缩整棵子树
                      setSelectedProjectId(null);
                      setSelectedCollectionId(null);
                      setSelectedRequestId(null);
                      setDraft(null);
                    } else {
                      setSelectedProjectId(project.id);
                      setSelectedCollectionId(null);
                      setSelectedRequestId(null);
                      setDraft(null);
                    }
                  },
                },
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: "none" } },
                    project.id === selectedProjectId ? "▾" : "▸"),
                  react.createElement("span", { style: { font: T.fontXsStrong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, project.name),
                ),
                project.id === selectedProjectId
                  ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2, paddingLeft: 10 } },
                    react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 8px" } },
                      react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: 1 } }, "集合"),
                      react.createElement(Button, { onClick: () => void addCollection(), style: { height: 20, padding: "0 6px", font: T.fontXxs } }, "+ 新建"),
                    ),
                    (project.collections ?? []).map((collection) => {
                      const colId = collection.id ?? collection.name;
                      return react.createElement("div", { key: colId, style: { display: "flex", flexDirection: "column", gap: 2 } },
                      react.createElement(Row, {
                        selected: colId === selectedCollectionId,
                        onClick: () => {
                          if (colId === selectedCollectionId) {
                            // 已展开 → 收缩该分类下的接口清单
                            setSelectedCollectionId(null);
                            setSelectedRequestId(null);
                            setDraft(null);
                          } else {
                            // 展开该分类,其它分类自动收起(单值展开)
                            setSelectedCollectionId(colId);
                            setSelectedRequestId(null);
                            setDraft(null);
                          }
                        },
                        style: { minHeight: 26 },
                      },
                        react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: "none" } },
                          colId === selectedCollectionId ? "▾" : "▸"),
                        react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, collection.name),
                        react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `${(collection.requests ?? []).length}`),
                      ),
                      colId === selectedCollectionId
                        ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2, paddingLeft: 10 } },
                          react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 8px" } },
                            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: 1 } }, "请求"),
                            react.createElement(Button, { onClick: addRequest, style: { height: 20, padding: "0 6px", font: T.fontXxs } }, "+ 新建"),
                          ),
                          (collection.requests ?? []).map((request) => {
                            const reqId = request.id ?? request.name;
                            return react.createElement(Row, {
                              key: reqId,
                              selected: reqId === selectedRequestId,
                              onClick: () => { setSelectedRequestId(reqId); setDraft(null); },
                              style: { minHeight: 26, gap: 6 },
                            },
                              react.createElement(MethodBadge, { method: request.method ?? "GET" }),
                              react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } },
                                request.name || request.url || "未命名请求"),
                              request.lastRun
                                ? react.createElement("span", {
                                  title: `上次执行 ${request.lastRun.pass ? "通过" : "失败"}${typeof request.lastRun.status === "number" ? ` HTTP ${request.lastRun.status}` : ""} · ${new Date(request.lastRun.at ?? "").toLocaleString()}${request.stats ? ` · 累计 ${request.stats.runs ?? 0} 次(通过 ${request.stats.passed ?? 0}/失败 ${request.stats.failed ?? 0})` : ""}`,
                                  style: { flex: "none", font: T.fontXxs, color: request.lastRun.pass ? T.success : T.error },
                                }, request.lastRun.pass ? "已通过" : "失败")
                                : null,
                            );
                          }),
                        )
                        : null,
                      );
                    }),
                  )
                  : null,
              )),
            ),
            // 右列:请求编辑 + 执行结果
            react.createElement("div", { style: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", boxSizing: "border-box", padding: 14 } },
              editingRequest
                ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 } },
                    selectedRequest?.lastPassed
                      ? react.createElement("div", { style: { ...cardStyle, gap: 6 } },
                        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                          react.createElement(Badge, { tone: "success" }, "已通过"),
                          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                            `上次通过 ${new Date(selectedRequest.lastPassed.at ?? "").toLocaleString()}${selectedRequest.stats ? ` · 累计 ${selectedRequest.stats.runs ?? 0} 次(通过 ${selectedRequest.stats.passed ?? 0}/失败 ${selectedRequest.stats.failed ?? 0})` : ""}`),
                          react.createElement("span", { style: { flex: 1 } }),
                          react.createElement(Button, {
                            title: "把通过时的请求数据填回编辑器(变量保持模板形式,不含替换后的敏感值)",
                            onClick: () => setDraft({ ...selectedRequest, ...selectedRequest.lastPassed.request, id: selectedRequest.id }),
                          }, "使用上次通过的数据"),
                        ),
                      )
                      : null,
                    react.createElement(RequestEditor, {
                      request: editingRequest,
                      onChange: setDraft,
                      onRun: (r) => { setDraft(r); void runRequest(r) },
                      onRunCollection: () => void runCollection(),
                      running,
                      generators,
                      project: selectedProject,
                      env: defaultEnvVariables,
                      collectionId: selectedCollection?.id,
                      inputActions: props.inputActions,
                    }),
                    result ? react.createElement("div", { style: { ...cardStyle, gap: 6 } },
                      react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                        react.createElement("span", { style: { font: T.fontXsStrong } }, "执行结果"),
                        result.collectionReport
                          ? react.createElement(Badge, { tone: result.collectionReport.summary?.failed > 0 ? "error" : "success" },
                            `${result.collectionReport.summary?.passed ?? 0}/${result.collectionReport.summary?.total ?? 0} 通过`)
                          : react.createElement(Badge, { tone: result.ok ? "success" : "error" }, result.ok ? "PASS" : "FAIL"),
                        result.status ? react.createElement(Badge, null, `HTTP ${result.status}`) : null,
                        typeof result.durationMs === "number" ? react.createElement(Badge, null, `${result.durationMs.toFixed(0)}ms`) : null,
                      ),
                      react.createElement("pre", { style: { font: T.fontMono, fontSize: 12, lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, color: T.labelSecondary } },
                        JSON.stringify(result, null, 2)),
                    ) : null,
                  )
                : react.createElement("div", { style: emptyStyle }, "选择或新建一个请求"),
            ),
          ),
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
        prompt ? react.createElement(PromptDialog, {
          title: prompt.title,
          initial: prompt.initial,
          onConfirm: (value) => void prompt.onConfirm(value),
          onCancel: () => setPrompt(null),
        }) : null,
      );
    }

    // ── 测试计划视图 ──────────────────────────────────────────────────────

    /** 规范化 URL 路径用于用例-接口匹配(去掉协议/主机/查询/哈希)。 */
    const matchPath = (url) => {
      const text = String(url ?? "").trim();
      if (!text) return null;
      let path = text;
      try {
        if (/^https?:\/\//i.test(text)) path = new URL(text).pathname;
        else path = text.split(/[?#]/)[0];
      } catch { path = text.split(/[?#]/)[0]; }
      return path.replace(/\/+$/, "") || "/";
    };

    /**
     * 判断用例步骤是否命中某接口(method + path)。
     * 来源:requestRef 解析 / step.data.url / 步骤描述开头的 "METHOD /path"。
     */
    const stepHitsRequest = (step, method, url, projects) => {
      const path = matchPath(url);
      if (!path) return false;
      const candidates = [];
      if (step?.requestRef && typeof step.requestRef === "object") {
        const project = (projects ?? []).find((p) => p.id === step.requestRef.projectId);
        const collection = project?.collections?.find((c) => (c.id ?? c.name) === step.requestRef.collectionId);
        const request = collection?.requests?.find((r) => (r.id ?? r.name) === step.requestRef.requestId);
        if (request) candidates.push({ method: request.method, path: matchPath(request.url) });
      }
      if (step?.data && typeof step.data === "object" && typeof step.data.url === "string" && step.data.url) {
        candidates.push({ method: step.data.method, path: matchPath(step.data.url) });
      }
      const actionMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(String(step?.action ?? ""));
      if (actionMatch) candidates.push({ method: actionMatch[1], path: matchPath(actionMatch[2]) });
      return candidates.some((c) => c.path && c.path === path && String(c.method ?? "GET").toUpperCase() === String(method ?? "GET").toUpperCase());
    };

    /** 用例多选弹窗:搜索 + 标签筛选 + 勾选(替代一行一个下拉)。 */
    function CasePickerDialog(props) {
      const { cases, tags, onConfirm, onCancel } = props;
      const [query, setQuery] = useState("");
      const [tag, setTag] = useState("");
      const [checked, setChecked] = useState({});
      const visible = (cases ?? []).filter((c) => {
        if (tag && !(c.tags ?? []).includes(tag)) return false;
        if (query) {
          const haystack = `${c.name ?? ""} ${c.description ?? ""} ${(c.tags ?? []).join(" ")}`.toLowerCase();
          if (!haystack.includes(query.toLowerCase())) return false;
        }
        return true;
      });
      const toggle = (id) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
      const selectAll = () => {
        const next = { ...checked };
        for (const c of visible) next[c.id] = true;
        setChecked(next);
      };
      const selectedIds = visible.filter((c) => checked[c.id]).map((c) => c.id);
      const confirm = () => { if (selectedIds.length > 0) onConfirm(selectedIds); };
      return react.createElement("div", { style: overlayStyle, onClick: onCancel },
        react.createElement("div", { style: { ...dialogCardStyle, width: 520, maxWidth: "92%", gap: 10 }, onClick: (e) => e.stopPropagation() },
          react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "添加用例(多选)"),
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `已选 ${selectedIds.length} / 可见 ${visible.length}`),
          ),
          react.createElement("div", { style: { display: "flex", gap: 6 } },
            react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "搜索名称/描述/标签…", value: query,
              onChange: (e) => setQuery(e.target.value) }),
            react.createElement("select", { style: { ...inputStyle, width: 130, flex: "none" }, value: tag, onChange: (e) => setTag(e.target.value) },
              react.createElement("option", { value: "" }, "全部标签"),
              (tags ?? []).map((t) => react.createElement("option", { key: t, value: t }, t)),
            ),
            react.createElement(Button, { onClick: selectAll, style: { flex: "none", height: 24 } }, "全选当前"),
          ),
          react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3, overflowY: "auto", maxHeight: 260, border: `1px solid ${T.borderL2}`, borderRadius: 6, padding: 6 } },
            visible.length === 0
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, padding: 6 } }, "没有匹配的用例")
              : visible.map((c) => react.createElement("label", { key: c.id, style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", font: T.fontXxs, color: T.labelSecondary } },
                react.createElement("input", { type: "checkbox", style: { margin: 0, accentColor: T.brand }, checked: checked[c.id] === true,
                  onChange: () => toggle(c.id) }),
                react.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.name ?? c.id),
                (c.tags ?? []).slice(0, 2).map((t) => react.createElement(Badge, { key: t }, t)),
              )),
          ),
          react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            react.createElement(Button, { onClick: onCancel }, "取消"),
            react.createElement(Button, { variant: "primary", onClick: confirm, disabled: selectedIds.length === 0 }, `添加 ${selectedIds.length} 个`),
          ),
        ),
      );
    }

    /** 集合多选弹窗:项目 → 勾选集合;支持一键「全选全部项目」做全量。 */
    function CollectionPickerDialog(props) {
      const { projects, onConfirm, onCancel } = props;
      const [projectId, setProjectId] = useState(projects?.[0]?.id ?? "");
      const [checked, setChecked] = useState({});
      const project = (projects ?? []).find((p) => p.id === projectId);
      const collections = project?.collections ?? [];
      const toggle = (id) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
      const collectFor = (proj) => (proj?.collections ?? []).map((c) => ({ projectId: proj.id, collectionId: c.id ?? c.name }));
      const selectAll = () => {
        const next = { ...checked };
        for (const c of collections) next[c.id ?? c.name] = true;
        setChecked(next);
      };
      const selected = collectFor(project).filter((x) => checked[x.collectionId]);
      const confirm = () => { if (selected.length > 0) onConfirm(selected); };
      const confirmAll = () => {
        const all = (projects ?? []).flatMap((p) => collectFor(p));
        if (all.length > 0) onConfirm(all);
      };
      return react.createElement("div", { style: overlayStyle, onClick: onCancel },
        react.createElement("div", { style: { ...dialogCardStyle, width: 480, maxWidth: "92%", gap: 10 }, onClick: (e) => e.stopPropagation() },
          react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "添加集合(多选)"),
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `已选 ${selected.length}`),
          ),
          react.createElement("select", { style: { ...inputStyle, width: "100%" }, value: projectId, onChange: (e) => { setProjectId(e.target.value); setChecked({}); } },
            (projects ?? []).map((p) => react.createElement("option", { key: p.id, value: p.id }, p.name)),
          ),
          react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3, overflowY: "auto", maxHeight: 240, border: `1px solid ${T.borderL2}`, borderRadius: 6, padding: 6 } },
            collections.length === 0
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, padding: 6 } }, "该项目下没有集合")
              : collections.map((c) => react.createElement("label", { key: c.id ?? c.name, style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", font: T.fontXxs, color: T.labelSecondary } },
                react.createElement("input", { type: "checkbox", style: { margin: 0, accentColor: T.brand }, checked: checked[c.id ?? c.name] === true,
                  onChange: () => toggle(c.id ?? c.name) }),
                react.createElement("span", { style: { flex: 1 } }, c.name ?? c.id),
                react.createElement(Badge, null, `${(c.requests ?? []).length} 接口`),
              )),
          ),
          react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 } },
            react.createElement(Button, { onClick: selectAll }, "全选该项目"),
            react.createElement(Button, { onClick: confirmAll }, "全选全部项目(全量)"),
          ),
          react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            react.createElement(Button, { onClick: onCancel }, "取消"),
            react.createElement(Button, { variant: "primary", onClick: confirm, disabled: selected.length === 0 }, `添加 ${selected.length} 个`),
          ),
        ),
      );
    }

    /** UI 脚本多选弹窗。 */
    function UiScriptPickerDialog(props) {
      const { uiScripts, onConfirm, onCancel } = props;
      const [checked, setChecked] = useState({});
      const toggle = (id) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
      const selectedIds = (uiScripts ?? []).filter((s) => checked[s.id]).map((s) => s.id);
      const confirm = () => { if (selectedIds.length > 0) onConfirm(selectedIds); };
      return react.createElement("div", { style: overlayStyle, onClick: onCancel },
        react.createElement("div", { style: { ...dialogCardStyle, width: 460, maxWidth: "92%", gap: 10 }, onClick: (e) => e.stopPropagation() },
          react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
            react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "添加 UI 脚本(多选)"),
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `已选 ${selectedIds.length}`),
          ),
          react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3, overflowY: "auto", maxHeight: 240, border: `1px solid ${T.borderL2}`, borderRadius: 6, padding: 6 } },
            (uiScripts ?? []).length === 0
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, padding: 6 } }, "还没有 UI 脚本,去「组件测试 → UI 脚本」创建")
              : (uiScripts ?? []).map((s) => react.createElement("label", { key: s.id, style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", font: T.fontXxs, color: T.labelSecondary } },
                react.createElement("input", { type: "checkbox", style: { margin: 0, accentColor: T.brand }, checked: checked[s.id] === true,
                  onChange: () => toggle(s.id) }),
                react.createElement("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, s.name ?? s.id),
              )),
          ),
          react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            react.createElement(Button, { onClick: onCancel }, "取消"),
            react.createElement(Button, { variant: "primary", onClick: confirm, disabled: selectedIds.length === 0 }, `添加 ${selectedIds.length} 个`),
          ),
        ),
      );
    }

    /** 增量变更弹窗:基线时间(默认最近计划执行) + 变更模块声明 + 预览展开结果 + 缺口。 */
    function IncrementalDialog(props) {
      const { workspaceId, tags, onConfirm, onCancel } = props;
      const [sinceLocal, setSinceLocal] = useState("");
      const [modules, setModules] = useState([]);
      const [previewing, setPreviewing] = useState(false);
      const [preview, setPreview] = useState(null);
      const [error, setError] = useState(null);
      useEffect(() => {
        if (!workspaceId) return;
        let alive = true;
        (async () => {
          try {
            const response = await window.fetch(`${ROUTE_ROOT}/api/reports?workspaceId=${encodeURIComponent(workspaceId)}`);
            const data = await response.json();
            const latest = (data.reports ?? []).find((r) => r.kind === "plan");
            if (alive && latest) {
              const d = new Date(latest.createdAt);
              const pad = (n) => String(n).padStart(2, "0");
              setSinceLocal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
            }
          } catch { /* 静默:拿不到基线就用当前时间 */ }
        })();
        return () => { alive = false; };
      }, [workspaceId]);
      const runPreview = async () => {
        setPreviewing(true); setError(null);
        try {
          const since = sinceLocal ? new Date(sinceLocal).toISOString() : "";
          const response = await window.fetch(`${ROUTE_ROOT}/api/plans/incremental-preview`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, since, modules }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setPreview(data);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setPreviewing(false);
        }
      };
      const confirm = () => {
        if (!preview) return;
        onConfirm({ since: sinceLocal ? new Date(sinceLocal).toISOString() : "", modules });
      };
      const toggleModule = (tag) => setModules((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
      return react.createElement("div", { style: overlayStyle, onClick: onCancel },
        react.createElement("div", { style: { ...dialogCardStyle, width: 540, maxWidth: "92%", gap: 10 }, onClick: (e) => e.stopPropagation() },
          react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "添加增量变更(版本迭代)"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            "执行时自动展开「自基线时间以来变更的接口/用例/UI 脚本」:重导 OpenAPI 自动 diff 出变更接口(写变更清单),AI 增改用例/脚本按文件变更时间收集;变更接口的覆盖用例、变更元素的引用脚本、变更表的依赖用例一并纳入。"),
          react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
            react.createElement("input", { type: "datetime-local", style: { ...inputStyle, flex: 1 }, value: sinceLocal,
              onChange: (e) => setSinceLocal(e.target.value) }),
            react.createElement(Button, { onClick: () => setSinceLocal(""), style: { flex: "none", height: 24 } }, "自动基线"),
          ),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            sinceLocal ? `基线:${new Date(sinceLocal).toLocaleString()}` : "自动基线:最近一次计划执行时间(执行时解析)"),
          react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
            react.createElement("span", { style: { ...fieldLabel, marginBottom: 0 } }, "变更模块(标签,可选)"),
            (tags ?? []).length === 0
              ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "还没有标签,可在「基础配置-标签」页维护;声明模块后按标签自动纳入相关用例")
              : react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                  (tags ?? []).map((tag) => react.createElement(Button, {
                    key: tag,
                    onClick: () => toggleModule(tag),
                    variant: modules.includes(tag) ? "primary" : "default",
                    style: { height: 22, padding: "0 8px", font: T.fontXxs },
                  }, tag)),
                ),
          ),
          react.createElement("div", { style: { display: "flex", gap: 6 } },
            react.createElement(Button, { onClick: () => void runPreview(), disabled: previewing }, previewing ? "预览中…" : "预览展开结果"),
            preview ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelSecondary, alignSelf: "center" } },
              `变更接口 ${preview.changedRequests ?? 0} · 变更用例 ${preview.changedCases ?? 0} · 覆盖用例 ${preview.coveringCases ?? 0} · UI 脚本 ${preview.changedScripts ?? 0}/${preview.affectedScripts ?? 0} · 合计 ${preview.totalEntries ?? 0}`) : null,
          ),
          preview && (preview.fromChangelog > 0 || preview.tableCases > 0 || preview.moduleCases > 0)
            ? react.createElement("div", { style: { font: T.fontXxs, color: T.labelCaption } },
                `来源:变更清单 ${preview.fromChangelog ?? 0} 份 · 表依赖 ${preview.tableCases ?? 0} 个用例 · 模块声明 ${preview.moduleCases ?? 0} 个用例`)
            : null,
          error ? react.createElement("div", { style: { color: T.error, font: T.fontXxs } }, error) : null,
          preview && (preview.gaps ?? []).length > 0
            ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3, border: `1px solid ${T.warnBorder ?? T.borderL2}`, borderRadius: 6, padding: 8, background: T.warnTint ?? "transparent" } },
                react.createElement("span", { style: { font: T.fontXxs, color: T.labelPrimary, fontWeight: 600 } },
                  `${preview.gaps.length} 个变更接口暂无用例覆盖(可用「AI 生成 · 缺口 mock」补测试后重跑)`),
                (preview.gaps ?? []).slice(0, 8).map((g, i) => react.createElement("span", { key: i, style: { font: T.fontXxs, color: T.labelSecondary } },
                  `${g.method} ${g.url}`)),
              )
            : null,
          react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
            react.createElement(Button, { onClick: onCancel }, "取消"),
            react.createElement(Button, { variant: "primary", onClick: confirm, disabled: !preview }, "添加增量条目"),
          ),
        ),
      );
    }

    const BUILTIN_GENERATORS = [
      { token: "{{rand.phone}}", label: "手机号", desc: "11 位手机号" },
      { token: "{{rand.email}}", label: "邮箱", desc: "随机邮箱" },
      { token: "{{rand.name}}", label: "中文姓名", desc: "2-3 字姓名" },
      { token: "{{rand.idcard}}", label: "身份证号", desc: "18 位" },
      { token: "{{rand.uuid}}", label: "UUID", desc: "v4" },
      { token: "{{rand.timestamp}}", label: "时间戳", desc: "毫秒" },
      { token: "{{rand.timestamp_s}}", label: "时间戳(秒)", desc: "秒" },
      { token: "{{rand.date}}", label: "日期", desc: "YYYY-MM-DD" },
      { token: "{{rand.number:1:100}}", label: "数字", desc: "区间整数" },
      { token: "{{rand.string:8}}", label: "随机串", desc: "小写字母" },
    ];

    function DataFactoryEditor(props) {
      const { workspaceId, initial, onSaved, onCancel } = props;
      const [key, setKey] = useState(initial?.key ?? "");
      const [name, setName] = useState(initial?.name ?? "");
      const [pattern, setPattern] = useState(initial?.pattern ?? "");
      const [description, setDescription] = useState(initial?.description ?? "");
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const [preview, setPreview] = useState(null);
      const [previewing, setPreviewing] = useState(false);

      const doPreview = async () => {
        setPreviewing(true); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/datafactory/preview`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, pattern, count: 3 }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setPreview(data.samples ?? []);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setPreviewing(false);
        }
      };

      const appendToken = (token) => {
        setPattern(`${pattern}${token}`);
      };

      const save = async () => {
        setSaving(true); setError(null);
        try {
          const payload = { workspaceId, key: key.trim(), name, pattern, description };
          const response = await window.fetch(
            `${ROUTE_ROOT}/api/datafactory${initial ? `/${initial.id}` : ""}`,
            {
              method: initial ? "PUT" : "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          const data = await response.json();
          if (!response.ok) { setError(data.message ?? `HTTP ${response.status}`); return; }
          onSaved(data.generator);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      };

      return react.createElement("div", { style: { ...cardStyle, gap: 14 } },
        react.createElement("div", { style: { font: T.fontXsStrong, color: T.labelPrimary } },
          initial ? "编辑生成器" : "新建生成器"),
        react.createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
          react.createElement("div", { style: { flex: 1, minWidth: 200 } },
            react.createElement("div", { style: fieldLabel }, "key(引用名)"),
            react.createElement("input", { style: inputStyle, value: key, disabled: !!initial,
              placeholder: "username", onChange: (e) => setKey(e.target.value) }),
          ),
          react.createElement("div", { style: { flex: 1, minWidth: 200 } },
            react.createElement("div", { style: fieldLabel }, "名称"),
            react.createElement("input", { style: inputStyle, value: name, placeholder: "用户名", onChange: (e) => setName(e.target.value) }),
          ),
        ),
        react.createElement(Section, {
          title: "模板(pattern)",
          right: react.createElement(Button, { onClick: () => void doPreview(), disabled: previewing || !pattern, style: { height: 22, padding: "0 8px" } },
            previewing ? "预览中…" : "预览"),
        },
          react.createElement("textarea", { style: { ...monoStyle, minHeight: 80 }, value: pattern,
            placeholder: "user_{{rand.number:1000:9999}}",
            onChange: (e) => setPattern(e.target.value) }),
          preview !== null ? react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "预览:"),
            preview.map((sample, i) => react.createElement(Badge, { key: i, tone: "brand" }, sample)),
          ) : null,
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            "用内置生成器组合模板,执行时动态展开;可嵌套其它自定义生成器。"),
          react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
            BUILTIN_GENERATORS.map((g) => react.createElement(Button, {
              key: g.token, title: `${g.label}: ${g.desc}`,
              onClick: () => appendToken(g.token),
              style: { height: 22, padding: "0 8px", font: T.fontXxs },
            }, g.label)),
          ),
        ),
        react.createElement(Section, { title: "描述(可选)" },
          react.createElement("input", { style: inputStyle, value: description, placeholder: "这个生成器的用途…", onChange: (e) => setDescription(e.target.value) })),
        error ? react.createElement("div", { style: { color: T.error, font: T.fontXxs } }, error) : null,
        react.createElement("div", { style: { display: "flex", gap: 8 } },
          react.createElement(Button, { variant: "primary", onClick: () => void save(), disabled: saving || !key.trim() },
            saving ? "保存中…" : "保存"),
          react.createElement(Button, { onClick: onCancel }, "取消"),
        ),
      );
    }

    function DataFactoryView(props) {
      const sessionId = props.sessionId;
      const embedded = props.embedded === true;
      const createSignal = Number(props.createSignal ?? 0);
      const onCountChange = props.onCountChange;
      const workspace = props.useWorkspaces((state) =>
        state.items.find((item) => item.sessionIds?.includes(sessionId)),
      );
      const workspaceId = workspace?.workspaceId ?? null;
      const [generators, setGenerators] = useState([]);
      const [loading, setLoading] = useState(true);
      const [editing, setEditing] = useState(null);
      const [detail, setDetail] = useState(null); // 详情弹窗选中的生成器
      const [error, setError] = useState(null);
      const [confirm, setConfirm] = useState(null); // { message, onConfirm } 删除确认

      const refresh = async () => {
        setLoading(true);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/datafactory?workspaceId=${encodeURIComponent(workspaceId)}`);
          const data = await response.json();
          if (data.ok) setGenerators(data.generators ?? []);
          else setError(data.message);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => { if (workspaceId) void refresh(); }, [workspaceId]);
      // 嵌入「基础配置」页时由外层工具栏触发新建:信号自增即打开编辑器。
      useEffect(() => { if (createSignal > 0) setEditing({}); }, [createSignal]);
      // 生成器数量回传给外层工具栏计数。
      useEffect(() => { if (typeof onCountChange === "function") onCountChange(generators.length); }, [generators.length, onCountChange]);

      const remove = (gen) => {
        setConfirm({
          message: `删除生成器「${gen.name || gen.key}」?`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/datafactory/${gen.id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) void refresh();
            else setError(data.message);
          },
        });
      };

      if (editing !== null) {
        return react.createElement("div", { style: rootStyle },
          react.createElement("div", { style: toolbarStyle },
            react.createElement(Button, { onClick: () => setEditing(null) }, "← 返回列表"),
            react.createElement("span", { style: toolbarTitle }, editing.gen ? "编辑生成器" : "新建生成器"),
          ),
          react.createElement("div", { style: scrollStyle },
            react.createElement("div", { style: contentColumn },
              react.createElement(DataFactoryEditor, {
                workspaceId, initial: editing.gen ?? undefined,
                onSaved: () => { setEditing(null); void refresh(); },
                onCancel: () => setEditing(null),
              }),
            ),
          ),
        );
      }

      return react.createElement("div", { style: rootStyle },
        embedded ? null : react.createElement("div", { style: toolbarStyle },
          react.createElement("span", { style: toolbarTitle }, "数据工厂"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `${generators.length}`),
          react.createElement("span", { style: toolbarSpacer }),
          react.createElement(Button, { variant: "primary", onClick: () => setEditing({}) }, "+ 新建生成器"),
        ),
        react.createElement("div", { style: scrollStyle },
          error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
          loading ? react.createElement("div", { style: emptyStyle }, "加载中…")
            : generators.length === 0
              ? react.createElement("div", { style: emptyStyle },
                "还没有生成器,点击「新建生成器」配置一个(如用户名、订单号、车牌号等)")
              : react.createElement("div", { style: { ...contentColumn, alignItems: "flex-start" } },
                react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                  generators.map((gen) => react.createElement(FactoryCard, {
                    key: gen.id,
                    gen,
                    onClick: () => setDetail(gen),
                  })),
                ),
                react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                  "✦ = 自定义生成器;点击卡片查看详情(内置生成器只读,自定义可编辑/删除)"),
              ),
        ),
        detail ? react.createElement(FactoryDetailDialog, {
          gen: detail,
          workspaceId,
          onEdit: detail.builtin ? undefined : () => { setDetail(null); setEditing({ gen: detail }); },
          onDelete: detail.builtin ? undefined : () => { setDetail(null); remove(detail); },
          onClose: () => setDetail(null),
        }) : null,
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
      );
    }




    // ── 环境配置视图 ──────────────────────────────────────────────────────

    function EnvironmentEditor(props) {
      const { workspaceId, initial, onSaved, onCancel } = props;
      const [name, setName] = useState(initial?.name ?? "");
      const [variables, setVariables] = useState(
        Object.entries(initial?.variables ?? {}).map(([key, value]) => ({ key, value: String(value) })),
      );
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);

      const save = async () => {
        setSaving(true); setError(null);
        try {
          const vars = {};
          for (const row of variables) {
            if (row.key.trim()) vars[row.key.trim()] = row.value;
          }
          const payload = { workspaceId, name, variables: vars };
          const response = await window.fetch(
            `${ROUTE_ROOT}/api/environments${initial ? `/${initial.id}` : ""}`,
            { method: initial ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
          );
          const data = await response.json();
          if (!response.ok) { setError(data.message ?? `HTTP ${response.status}`); return; }
          onSaved(data.environment);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      };

      const update = (index, field, next) => {
        setVariables(variables.map((v, i) => (i === index ? { ...v, [field]: next } : v)));
      };

      return react.createElement("div", { style: { ...cardStyle, gap: 14 } },
        react.createElement("div", { style: { font: T.fontXsStrong, color: T.labelPrimary } },
          initial ? "编辑环境" : "新建环境"),
        react.createElement(Section, { title: "名称" },
          react.createElement("input", { style: inputStyle, value: name, placeholder: "测试环境 / 生产环境…", onChange: (e) => setName(e.target.value) })),
        react.createElement(Section, {
          title: "变量(值支持 {{VAR}} / {{rand.*}} / {{factory.*}},执行时动态展开)",
          right: react.createElement(Button, { onClick: () => setVariables([...variables, { key: "", value: "" }]), style: { height: 22, padding: "0 8px" } }, "+ 添加变量"),
        },
          variables.length === 0
            ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "还没有变量,点击「+ 添加变量」")
            : variables.map((row, index) => react.createElement("div", { key: index, style: { display: "flex", gap: 6, alignItems: "center" } },
              react.createElement("input", { style: { ...inputStyle, flex: 1, font: T.fontMono, fontSize: 11 }, placeholder: "变量名,如 BASE_URL", value: row.key,
                onChange: (e) => update(index, "key", e.target.value) }),
              react.createElement("input", { style: { ...inputStyle, flex: 2, font: T.fontMono, fontSize: 11 }, placeholder: "值,如 https://test.example.com", value: row.value,
                onChange: (e) => update(index, "value", e.target.value) }),
              react.createElement(Button, { onClick: () => setVariables(variables.filter((_, i) => i !== index)), style: { padding: "0 6px", height: 22 } }, "×"),
            )),
        ),
        error ? react.createElement("div", { style: { color: T.error, font: T.fontXxs } }, error) : null,
        react.createElement("div", { style: { display: "flex", gap: 8 } },
          react.createElement(Button, { variant: "primary", onClick: () => void save(), disabled: saving || !name.trim() },
            saving ? "保存中…" : "保存"),
          react.createElement(Button, { onClick: onCancel }, "取消"),
        ),
      );
    }

    function EnvironmentView(props) {
      const sessionId = props.sessionId;
      const workspace = props.useWorkspaces((state) =>
        state.items.find((item) => item.sessionIds?.includes(sessionId)),
      );
      const workspaceId = workspace?.workspaceId ?? null;
      const [tab, setTab] = useState("environments"); // environments | tags | dbdata | datafactory
      const [factoryCount, setFactoryCount] = useState(0);
      const [factoryCreateTick, setFactoryCreateTick] = useState(0);
      const [environments, setEnvironments] = useState([]);
      const [defaultId, setDefaultId] = useState(null);
      const [tags, setTags] = useState([]);
      const [dbTables, setDbTables] = useState([]);
      const [dbSchema, setDbSchema] = useState("");
      const [sessionByEnv, setSessionByEnv] = useState({}); // envId -> [{ name, value, at }]
      const [newTag, setNewTag] = useState("");
      const [adding, setAdding] = useState(false);
      const [loading, setLoading] = useState(true);
      const [editing, setEditing] = useState(null); // null=列表, {}=新建, {env}=编辑
      const [error, setError] = useState(null);
      const [confirm, setConfirm] = useState(null); // { message, onConfirm } 删除确认

      const refresh = async () => {
        setLoading(true);
        try {
          const [e, t, d, s] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/tags?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/dbdata?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/session?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
          ]);
          if (e.ok) { setEnvironments(e.environments ?? []); setDefaultId(e.defaultEnvironmentId ?? null); }
          else setError(e.message);
          if (t.ok) setTags(t.tags ?? []);
          if (d.ok) { setDbTables(d.tables ?? []); setDbSchema(d.schemaText ?? ""); }
          if (s.ok) {
            // /api/session 不带 environmentId 时返回全部环境的变量。
            const grouped = {};
            for (const v of s.variables ?? []) {
              if (v.environmentId) (grouped[v.environmentId] ??= []).push(v);
            }
            setSessionByEnv(grouped);
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => { if (workspaceId) void refresh(); }, [workspaceId]);

      const setDefault = async (env) => {
        setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/environments/${env.id}/default`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setDefaultId(env.id);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      };

      const remove = (env) => {
        setConfirm({
          message: `删除环境「${env.name}」?`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/environments/${env.id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) void refresh();
            else setError(data.message);
          },
        });
      };

      const clearSession = async (envId) => {
        setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/session/${encodeURIComponent(envId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          void refresh();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      };

      const addTag = async () => {
        setAdding(true); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/tags`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, name: newTag }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setTags(data.tags ?? []);
          setNewTag("");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setAdding(false);
        }
      };

      const removeTag = (tag) => {
        setConfirm({
          message: `删除标签「${tag}」?删除后仍使用该标签的用例在保存时会被校验拒绝。`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/tags/${encodeURIComponent(tag)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) setTags(data.tags ?? []);
            else setError(data.message);
          },
        });
      };

      if (editing !== null) {
        return react.createElement("div", { style: rootStyle },
          react.createElement("div", { style: toolbarStyle },
            react.createElement(Button, { onClick: () => setEditing(null) }, "← 返回列表"),
            react.createElement("span", { style: toolbarTitle }, editing.env ? "编辑环境" : "新建环境"),
          ),
          react.createElement("div", { style: scrollStyle },
            react.createElement("div", { style: contentColumn },
              react.createElement(EnvironmentEditor, {
                workspaceId, initial: editing.env ?? undefined,
                onSaved: () => { setEditing(null); void refresh(); },
                onCancel: () => setEditing(null),
              }),
            ),
          ),
        );
      }

      /** 快速筛选按钮(结果/优先级),配合 data 属性供测试定位。 */
      const tabButton = (target, label) => react.createElement(Button, {
        onClick: () => setTab(target),
        style: {
          height: 24, padding: "0 10px", borderRadius: 6, font: T.fontXxs,
          fontWeight: tab === target ? 600 : 500,
          color: tab === target ? T.labelPrimary : T.labelTertiary,
        },
      }, label);

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          react.createElement("span", { style: toolbarTitle }, "基础配置"),
          tabButton("environments", "环境"),
          tabButton("tags", "标签"),
          tabButton("dbdata", "数据参考"),
          tabButton("datafactory", "数据工厂"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            tab === "environments" ? `${environments.length}` : tab === "datafactory" ? `${factoryCount}` : `${tags.length}`),
          react.createElement("span", { style: toolbarSpacer }),
          tab === "environments"
            ? react.createElement(Button, { variant: "primary", onClick: () => setEditing({}) }, "+ 新建环境")
            : tab === "datafactory"
              ? react.createElement(Button, { variant: "primary", onClick: () => setFactoryCreateTick((tick) => tick + 1) }, "+ 新建生成器")
              : null,
        ),
        react.createElement("div", { style: scrollStyle },
          error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
          loading ? react.createElement("div", { style: emptyStyle }, "加载中…")
            : tab === "datafactory"
              ? react.createElement(DataFactoryView, {
                ...props, embedded: true, createSignal: factoryCreateTick, onCountChange: setFactoryCount,
              })
              : tab === "environments"
              ? (environments.length === 0
                ? react.createElement("div", { style: emptyStyle },
                  "还没有环境,点击「新建环境」配置测试环境变量(如 BASE_URL、TOKEN);所有执行(API/用例/UI/计划)未指定环境时自动使用默认环境")
                : react.createElement("div", { style: contentColumn },
                  environments.map((env) => react.createElement("div", { key: env.id, style: cardStyle },
                    react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
                      react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                        react.createElement(Badge, { tone: "brand" }, env.name),
                        env.id === defaultId ? react.createElement(Badge, { tone: "success" }, "默认") : null,
                        react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                          `${Object.keys(env.variables ?? {}).length} 个变量`),
                      ),
                      react.createElement("div", { style: { display: "flex", gap: 6, flex: "none" } },
                        env.id !== defaultId
                          ? react.createElement(Button, { onClick: () => void setDefault(env), style: { height: 22, padding: "0 8px", font: T.fontXxs } }, "设为默认")
                          : null,
                        react.createElement(Button, { onClick: () => setEditing({ env }) }, "编辑"),
                        react.createElement(Button, { variant: "danger", onClick: () => void remove(env) }, "删除"),
                      ),
                    ),
                    Object.keys(env.variables ?? {}).length > 0
                      ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                        Object.entries(env.variables ?? {}).map(([key, value]) => react.createElement("div", { key: key, style: { display: "flex", gap: 8, font: T.fontXxs } },
                          react.createElement("span", { style: { font: T.fontMono, fontSize: 11, color: T.labelSecondary, flex: "none" } }, key),
                          react.createElement("span", { style: { font: T.fontMono, fontSize: 11, color: T.labelTertiary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(value)),
                        )),
                      )
                      : react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "(空环境,无变量)"),
                    (sessionByEnv[env.id] ?? []).length > 0
                      ? react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 } },
                        react.createElement(Badge, { tone: "warn" },
                          `会话: ${(sessionByEnv[env.id] ?? []).map((v) => v.name).join(", ")}`),
                        react.createElement(Button, {
                          onClick: () => void clearSession(env.id),
                          style: { height: 18, padding: "0 6px", font: T.fontXxs },
                        }, "清除会话"),
                      )
                      : null,
                  )),
                ))
              : (tab === "tags"
                ? react.createElement("div", { style: contentColumn },
                  react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                    react.createElement("input", {
                      style: { ...inputStyle, flex: 1 },
                      placeholder: "新标签名(如 冒烟 / 回归 / 登录)",
                      value: newTag,
                      onChange: (e) => setNewTag(e.target.value),
                      onKeyDown: (e) => { if (e.key === "Enter") void addTag(); },
                  }),
                  react.createElement(AiButton, {
                    title: "智能整理标签(分析全部用例,给出标签库与用例打标建议)",
                    onClick: makeAiClick(props, "tags", { tags }),
                  }, "AI 生成 · 整理标签"),
                  react.createElement(Button, { variant: "primary", onClick: () => void addTag(), disabled: adding || !newTag.trim() },
                    adding ? "添加中…" : "+ 添加"),
                ),
                react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                  "用例标签只能从标签库选择;删除标签后,仍使用该标签的用例在保存时会被校验拒绝。"),
                tags.length === 0
                  ? react.createElement("div", { style: emptyStyle }, "还没有标签,先添加几个(如 冒烟、回归、登录)")
                  : react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                    tags.map((tag) => react.createElement("div", { key: tag, style: { display: "flex", gap: 6, alignItems: "center", padding: "4px 6px 4px 10px", borderRadius: 6, border: `1px solid ${T.borderL2}`, background: T.bgLayer2 } },
                      react.createElement("span", { style: { font: T.fontXxs, color: T.labelPrimary } }, tag),
                      react.createElement(Button, { onClick: () => void removeTag(tag), style: { height: 18, padding: "0 4px", font: T.fontXxs, color: T.error } }, "×"),
                    )),
                  ),
              )
                : react.createElement("div", { style: contentColumn },
                  react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
                    react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "数据库参考数据"),
                    react.createElement(Button, { onClick: () => void refresh(), style: { height: 22, padding: "0 8px", font: T.fontXxs } }, "刷新"),
                  ),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, lineHeight: 1.6 } },
                    "把数据库的表结构与测试数据导出后放在 test-mode/dbdata/ 目录(不直连数据库):"),
                  react.createElement("div", { style: { font: T.fontMono, fontSize: 11, color: T.labelTertiary, lineHeight: 1.7, background: T.bgLayer2, borderRadius: 6, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-all" } },
                    "test-mode/dbdata/\n├── schema.md            (可选)表结构说明\n├── users.csv            测试数据(CSV:首行表头)\n├── plugins.md           测试数据(Markdown 表格)\n└── orders.xlsx          测试数据(Excel:每 sheet 一张表,首行表头)"),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                    "智能体生成 mock 测试数据 / 写断言时会参考这些数据,保证测试数据与预期贴近真实。"),
                  dbTables.length === 0
                    ? react.createElement("div", { style: emptyStyle },
                      "还没有数据参考文件,导出表数据后放入 test-mode/dbdata/ 目录再点「刷新」")
                    : react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                      dbTables.map((table) => react.createElement("div", { key: `${table.name}-${table.format}`, style: cardStyle },
                        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                          react.createElement(Badge, { tone: "brand" }, table.name),
                          react.createElement(Badge, null, table.format),
                          react.createElement(Badge, null, `${table.rowCount} 行`),
                          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                            `字段: ${(table.columns ?? []).join(", ")}`),
                        ),
                        (table.sample ?? []).length > 0
                          ? react.createElement("table", { style: { borderCollapse: "collapse", width: "100%", font: T.fontXxs } },
                            react.createElement("thead", null,
                              react.createElement("tr", null,
                                (table.columns ?? []).map((col, ci) => react.createElement("th", { key: ci, style: { textAlign: "left", padding: "4px 8px", borderBottom: `1px solid ${T.borderL2}`, color: T.labelTertiary, fontWeight: 500 } }, col))),
                            ),
                            react.createElement("tbody", null,
                              (table.sample ?? []).map((row, ri) => react.createElement("tr", { key: ri },
                                (table.columns ?? []).map((col, ci) => react.createElement("td", { key: ci, style: { padding: "3px 8px", borderBottom: `1px solid ${T.borderL1}`, color: T.labelSecondary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 } }, String(row[ci] ?? ""))),
                              )),
                            ),
                          )
                          : react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "(空表)"),
                      )),
                      dbSchema
                        ? react.createElement("div", { style: { ...cardStyle, gap: 6 } },
                          react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "schema.md"),
                          react.createElement("pre", { style: { font: T.fontMono, fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, color: T.labelSecondary } }, dbSchema),
                        )
                        : null,
                    ),
                )
              ),
        ),
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
      );
    }


    // ── UI 自动化视图 ─────────────────────────────────────────────────────

    // 脚本步骤 kind 清单(与后端 ui-test.js 对应)。
    const UI_STEP_KINDS = [
      { kind: "open", label: "打开 URL", fields: ["url"] },
      { kind: "click", label: "点击", fields: ["element"] },
      { kind: "type", label: "输入", fields: ["element", "text"] },
      { kind: "press", label: "按键", fields: ["key"] },
      { kind: "assert_text", label: "断言文本", fields: ["element", "expect"] },
      { kind: "assert_url", label: "断言 URL", fields: ["expect"] },
      { kind: "assert_title", label: "断言标题", fields: ["expect"] },
      { kind: "assert_element", label: "断言元素", fields: ["element"] },
      { kind: "eval", label: "执行 JS", fields: ["expression"] },
      { kind: "wait", label: "等待", fields: ["ms"] },
      { kind: "screenshot", label: "截图", fields: ["path"] },
    ];

    function UiStepEditor(props) {
      const { step, index, elements, onChange, onRemove } = props;
      const kindMeta = UI_STEP_KINDS.find((k) => k.kind === step.kind) ?? UI_STEP_KINDS[0];
      const update = (field, value) => onChange({ ...step, [field]: value });
      const hasField = (f) => kindMeta.fields.includes(f);
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, padding: 8, borderRadius: 8, border: `1px solid ${T.borderL2}`, background: T.bgLayer2 } },
        react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption, flex: "none", width: 20 } }, `${index + 1}`),
          react.createElement("select", { style: { ...inputStyle, width: 130, flex: "none" }, value: step.kind ?? "eval",
            onChange: (e) => onChange({ ...step, kind: e.target.value }) },
            UI_STEP_KINDS.map((k) => react.createElement("option", { key: k.kind, value: k.kind }, k.label))),
          react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "步骤名称(可选)", value: step.name ?? "",
            onChange: (e) => update("name", e.target.value) }),
          react.createElement(Button, { onClick: onRemove, style: { padding: "0 6px", height: 22 } }, "×"),
        ),
        react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          hasField("url") ? react.createElement("input", { style: { ...inputStyle, flex: 2, font: T.fontMono, fontSize: 11 }, placeholder: "URL(支持 {{VAR}} / {{factory.*}})", value: step.url ?? "",
            onChange: (e) => update("url", e.target.value) }) : null,
          hasField("element") ? react.createElement("select", { style: { ...inputStyle, flex: 1 }, value: step.element ?? "",
            onChange: (e) => update("element", e.target.value) },
            react.createElement("option", { value: "" }, "(选择元素)"),
            elements.map((el) => react.createElement("option", { key: el.id, value: el.key }, `${el.key} — ${el.selector}`)),
          ) : null,
          hasField("selector") ? react.createElement("input", { style: { ...inputStyle, flex: 1, font: T.fontMono, fontSize: 11 }, placeholder: "CSS selector", value: step.selector ?? "",
            onChange: (e) => update("selector", e.target.value) }) : null,
          hasField("text") ? react.createElement("input", { style: { ...inputStyle, flex: 1, font: T.fontMono, fontSize: 11 }, placeholder: "输入文本(支持 {{factory.*}})", value: step.text ?? "",
            onChange: (e) => update("text", e.target.value) }) : null,
          hasField("key") ? react.createElement("input", { style: { ...inputStyle, width: 120, flex: "none" }, placeholder: "Enter/Tab/…", value: step.key ?? "",
            onChange: (e) => update("key", e.target.value) }) : null,
          hasField("expect") ? react.createElement("input", { style: { ...inputStyle, flex: 1 }, placeholder: "期望值", value: step.expect ?? "",
            onChange: (e) => update("expect", e.target.value) }) : null,
          hasField("expression") ? react.createElement("input", { style: { ...inputStyle, flex: 2, font: T.fontMono, fontSize: 11 }, placeholder: "JS 表达式", value: step.expression ?? "",
            onChange: (e) => update("expression", e.target.value) }) : null,
          hasField("ms") ? react.createElement("input", { style: { ...inputStyle, width: 100, flex: "none" }, placeholder: "毫秒", value: step.ms ?? "",
            onChange: (e) => update("ms", e.target.value) }) : null,
          hasField("path") ? react.createElement("input", { style: { ...inputStyle, flex: 1, font: T.fontMono, fontSize: 11 }, placeholder: "截图路径", value: step.path ?? "",
            onChange: (e) => update("path", e.target.value) }) : null,
        ),
      );
    }

    function UiScriptEditor(props) {
      const { workspaceId, initial, onSaved, onCancel, elements } = props;
      const [name, setName] = useState(initial?.name ?? "");
      const [steps, setSteps] = useState(initial?.steps ?? [{ kind: "open", name: "", url: "" }]);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const updateStep = (index, next) => setSteps(steps.map((s, i) => (i === index ? next : s)));
      const removeStep = (index) => setSteps(steps.filter((_, i) => i !== index));
      const addStep = (kind) => setSteps([...steps, { kind, name: "" }]);
      const save = async () => {
        setSaving(true); setError(null);
        try {
          const payload = { workspaceId, name, steps: steps.filter((s) => s.kind) };
          const response = await window.fetch(
            `${ROUTE_ROOT}/api/ui/scripts${initial ? `/${initial.id}` : ""}`,
            { method: initial ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
          );
          const data = await response.json();
          if (!response.ok) { setError(data.message ?? `HTTP ${response.status}`); return; }
          onSaved(data.script);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setSaving(false);
        }
      };
      return react.createElement("div", { style: { ...cardStyle, gap: 12 } },
        react.createElement("div", { style: { font: T.fontXsStrong, color: T.labelPrimary } },
          initial ? "编辑 UI 脚本" : "新建 UI 脚本"),
        react.createElement(Section, { title: "名称" },
          react.createElement("input", { style: inputStyle, value: name, onChange: (e) => setName(e.target.value) })),
        react.createElement(Section, {
          title: "步骤",
          right: react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
            react.createElement(Button, { onClick: () => addStep("open"), style: { height: 22, padding: "0 8px", font: T.fontXxs } }, "+ 打开"),
            react.createElement(Button, { onClick: () => addStep("click"), style: { height: 22, padding: "0 8px", font: T.fontXxs } }, "+ 点击"),
            react.createElement(Button, { onClick: () => addStep("type"), style: { height: 22, padding: "0 8px", font: T.fontXxs } }, "+ 输入"),
            react.createElement(Button, { onClick: () => addStep("assert_text"), style: { height: 22, padding: "0 8px", font: T.fontXxs } }, "+ 断言"),
          ),
        },
          steps.length === 0
            ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "还没有步骤,点击上方按钮添加(打开/点击/输入/断言…)")
            : steps.map((step, index) => react.createElement(UiStepEditor, {
              key: index, step, index, elements,
              onChange: (next) => updateStep(index, next),
              onRemove: () => removeStep(index),
            })),
        ),
        error ? react.createElement("div", { style: { color: T.error, font: T.fontXxs } }, error) : null,
        react.createElement("div", { style: { display: "flex", gap: 8 } },
          react.createElement(Button, { variant: "primary", onClick: () => void save(), disabled: saving || !name.trim() },
            saving ? "保存中…" : "保存"),
          react.createElement(Button, { onClick: onCancel }, "取消"),
        ),
      );
    }

    function UiAutomationView(props) {
      const sessionId = props.sessionId;
      const workspace = props.useWorkspaces((state) =>
        state.items.find((item) => item.sessionIds?.includes(sessionId)),
      );
      const workspaceId = workspace?.workspaceId ?? null;
      const [tab, setTab] = useState("scripts");
      const [scripts, setScripts] = useState([]);
      const [elements, setElements] = useState([]);
      const [environments, setEnvironments] = useState([]);
      const [defaultEnvId, setDefaultEnvId] = useState("");
      const [selectedEnvId, setSelectedEnvId] = useState("");
      const [loading, setLoading] = useState(true);
      const [editing, setEditing] = useState(null); // null=列表, {}=新建脚本, {script}=编辑
      const [editingElement, setEditingElement] = useState(null); // null | {}=新建元素 | {element}
      const [running, setRunning] = useState(null);
      const [runResult, setRunResult] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null); // 成功提示(如恢复通过版本)
      const [confirm, setConfirm] = useState(null); // { message, onConfirm } 删除确认

      const refresh = async () => {
        setLoading(true);
        try {
          const [s, e, env] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/ui/scripts?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/ui/elements?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
          ]);
          if (s.ok) setScripts(s.scripts ?? []);
          if (e.ok) setElements(e.elements ?? []);
          if (env.ok) { setEnvironments(env.environments ?? []); setDefaultEnvId(env.defaultEnvironmentId ?? ""); }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      };

      useEffect(() => { if (workspaceId) void refresh(); }, [workspaceId]);

      const runScript = async (script) => {
        setRunning(script.id); setRunResult(null); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/ui/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, scriptId: script.id, environmentId: selectedEnvId }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setRunResult(data.report);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setRunning(null);
        }
      };

      const removeScript = (script) => {
        setConfirm({
          message: `删除脚本「${script.name}」?`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/ui/scripts/${script.id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) void refresh();
            else setError(data.message);
          },
        });
      };

      /**
       * 恢复「上次通过的脚本版本」:把 lastPassed.steps 写回脚本配置。
       * @param script - UI 脚本。
       */
      const restorePassedSteps = async (script) => {
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/ui/scripts/${script.id}`, {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, steps: script.lastPassed?.steps ?? [] }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setNotice("已恢复为上次通过的脚本版本");
          void refresh();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      };

      const saveElement = async (payload) => {
        const response = await window.fetch(
          `${ROUTE_ROOT}/api/ui/elements${editingElement.element ? `/${editingElement.element.id}` : ""}`,
          { method: editingElement.element ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, ...payload }) },
        );
        const data = await response.json();
        if (!data.ok) { setError(data.message); return; }
        setEditingElement(null);
        void refresh();
      };

      const removeElement = (element) => {
        setConfirm({
          message: `删除元素「${element.key}」?`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/ui/elements/${element.id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) void refresh();
            else setError(data.message);
          },
        });
      };

      const tabButton = (target, label) => react.createElement(Button, {
        onClick: () => setTab(target),
        style: {
          height: 24, padding: "0 10px", borderRadius: 6, font: T.fontXxs,
          fontWeight: tab === target ? 600 : 500,
          color: tab === target ? T.labelPrimary : T.labelTertiary,
          background: tab === target ? T.hover : "transparent",
        },
      }, label);

      const defaultEnv = environments.find((env) => env.id === defaultEnvId);
      const envUrl = (Object.entries(defaultEnv?.variables ?? {}).find(([key]) => /^(base_?url|url)$/i.test(key))?.[1] ?? "");

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          tabButton("scripts", "脚本"),
          tabButton("elements", "元素库"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            tab === "scripts" ? `${scripts.length}` : `${elements.length}`),
          react.createElement("span", { style: toolbarSpacer }),
          tab === "scripts"
            ? react.createElement(AiButton, {
                title: envUrl ? `生成 UI 自动化脚本(目标 URL 已从默认环境获取: ${envUrl})` : "生成 UI 自动化脚本(未在默认环境找到 BASE_URL,请在输入框补充目标 URL)",
                onClick: makeAiClick(props, "ui", { baseUrl: envUrl, elements }),
              }, "AI 生成 · UI 脚本")
            : react.createElement(AiButton, {
                title: "从源码或页面提取元素到元素库(请在输入框补充源码位置或页面 URL)",
                onClick: makeAiClick(props, "elements", { elements }),
              }, "AI 生成 · 提取元素"),
          react.createElement("select", { style: { ...inputStyle, width: "auto" }, value: selectedEnvId,
            title: "执行脚本时使用的环境(未选则用默认环境)",
            onChange: (e) => setSelectedEnvId(e.target.value) },
            react.createElement("option", { value: "" }, "(默认环境)"),
            environments.map((env) => react.createElement("option", { key: env.id, value: env.id }, env.name))),
          tab === "scripts"
            ? react.createElement(Button, { variant: "primary", onClick: () => setEditing({}) }, "+ 新建脚本")
            : react.createElement(Button, { variant: "primary", onClick: () => setEditingElement({}) }, "+ 新建元素"),
        ),
        react.createElement("div", { style: scrollStyle },
          error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
          loading ? react.createElement("div", { style: emptyStyle }, "加载中…")
            : tab === "scripts"
              ? (editing !== null
                ? react.createElement("div", { style: contentColumn },
                  react.createElement(UiScriptEditor, {
                    workspaceId, initial: editing.script ?? undefined, elements,
                    onSaved: () => { setEditing(null); void refresh(); },
                    onCancel: () => setEditing(null),
                  }),
                )
                : (scripts.length === 0
                  ? react.createElement("div", { style: emptyStyle },
                    "还没有 UI 脚本,点击「新建脚本」编排浏览器自动化步骤(执行引擎:Playwright + 系统 Chrome,无需额外浏览器插件)")
                  : react.createElement("div", { style: contentColumn },
                    scripts.map((script) => react.createElement("div", { key: script.id, style: cardStyle },
                      react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
                        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                          react.createElement(Badge, { tone: "brand" }, "UI"),
                          react.createElement("strong", { style: { font: T.fontXsStrong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, script.name),
                        ),
                        react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flex: "none" } },
                          script.lastRun
                            ? react.createElement("span", {
                              title: `上次执行 ${script.lastRun.pass ? "通过" : "失败"} · ${new Date(script.lastRun.at ?? "").toLocaleString()}${script.stats ? ` · 累计 ${script.stats.runs ?? 0} 次(通过 ${script.stats.passed ?? 0}/失败 ${script.stats.failed ?? 0})` : ""}`,
                              style: { font: T.fontXxs, color: script.lastRun.pass ? T.success : T.error },
                            }, script.lastRun.pass ? "已通过" : "失败")
                            : null,
                          react.createElement(Badge, null, `${(script.steps ?? []).length} 步`),
                        ),
                      ),
                      react.createElement("div", { style: { display: "flex", gap: 6 } },
                        react.createElement(Button, { variant: "primary", onClick: () => void runScript(script), disabled: running !== null },
                          running === script.id ? "执行中…" : "执行"),
                        script.lastPassed && JSON.stringify(script.lastPassed.steps ?? []) !== JSON.stringify(script.steps ?? [])
                          ? react.createElement(Button, {
                            title: `当前步骤与上次通过时(${new Date(script.lastPassed.at ?? "").toLocaleString()})不同,可一键恢复`,
                            onClick: () => void restorePassedSteps(script),
                          }, "恢复通过版本")
                          : null,
                        react.createElement(Button, { onClick: () => setEditing({ script }) }, "编辑"),
                        react.createElement(Button, { variant: "danger", onClick: () => void removeScript(script) }, "删除"),
                      ),
                    )),
                    runResult ? react.createElement("div", { style: { ...cardStyle, gap: 6, borderColor: runResult.summary?.failed > 0 ? T.error : T.success } },
                      react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                        react.createElement("span", { style: { font: T.fontXsStrong } }, `UI 执行: ${runResult.name}`),
                        react.createElement(Badge, { tone: runResult.summary?.failed > 0 ? "error" : "success" },
                          `${runResult.summary?.passed ?? 0}/${runResult.summary?.total ?? 0} 通过`),
                        react.createElement(Badge, null, `${(runResult.durationMs ?? 0).toFixed(0)}ms`),
                        react.createElement("span", { style: { flex: 1 } }),
                        react.createElement(Button, { onClick: () => setRunResult(null), style: { height: 20, padding: "0 6px" } }, "关闭"),
                      ),
                      (runResult.results ?? []).map((entry, i) => react.createElement("div", { key: i, style: { display: "flex", alignItems: "center", gap: 8, font: T.fontXxs } },
                        react.createElement("span", { style: { flex: "none", width: 16, color: entry.pass ? T.success : T.error, fontWeight: 700 } },
                          entry.pass ? "✓" : "✗"),
                        react.createElement("Badge", { tone: entry.pass ? "success" : "error" },
                          UI_STEP_KINDS.find((k) => k.kind === entry.kind)?.label ?? entry.kind),
                        react.createElement("span", { style: { color: T.labelSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.name),
                        entry.error
                          ? react.createElement("span", { style: { color: T.error, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, entry.error)
                          : null,
                      )),
                    ) : null,
                  )))
              : (editingElement !== null
                ? react.createElement("div", { style: contentColumn },
                  react.createElement("div", { style: { ...cardStyle, gap: 12 } },
                    react.createElement("div", { style: { font: T.fontXsStrong, color: T.labelPrimary } },
                      editingElement.element ? "编辑元素" : "新建元素"),
                    react.createElement("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" } },
                      react.createElement("div", { style: { flex: 1, minWidth: 160 } },
                        react.createElement("div", { style: fieldLabel }, "key(脚本中引用)"),
                        react.createElement("input", { id: "el-key", style: inputStyle, placeholder: "login-btn", defaultValue: editingElement.element?.key ?? "" }),
                      ),
                      react.createElement("div", { style: { flex: 1, minWidth: 160 } },
                        react.createElement("div", { style: fieldLabel }, "CSS selector"),
                        react.createElement("input", { id: "el-sel", style: { ...inputStyle, font: T.fontMono, fontSize: 11 }, placeholder: "#login-btn", defaultValue: editingElement.element?.selector ?? "" }),
                      ),
                      react.createElement("div", { style: { flex: 1, minWidth: 160 } },
                        react.createElement("div", { style: fieldLabel }, "页面(可选)"),
                        react.createElement("input", { id: "el-page", style: inputStyle, placeholder: "/login", defaultValue: editingElement.element?.page ?? "" }),
                      ),
                    ),
                    react.createElement("div", null,
                      react.createElement("div", { style: fieldLabel }, "描述(可选)"),
                      react.createElement("input", { id: "el-desc", style: inputStyle, defaultValue: editingElement.element?.description ?? "" }),
                    ),
                    react.createElement("div", { style: { display: "flex", gap: 8 } },
                      react.createElement(Button, { variant: "primary", onClick: () => {
                        void saveElement({
                          key: document.getElementById("el-key")?.value ?? "",
                          selector: document.getElementById("el-sel")?.value ?? "",
                          page: document.getElementById("el-page")?.value ?? "",
                          description: document.getElementById("el-desc")?.value ?? "",
                        });
                      } }, "保存"),
                      react.createElement(Button, { onClick: () => setEditingElement(null) }, "取消"),
                    ),
                  ),
                )
                : (elements.length === 0
                  ? react.createElement("div", { style: emptyStyle }, "还没有元素,点击「新建元素」把常用 CSS 定位存下来复用")
                  : react.createElement("div", { style: contentColumn },
                    elements.map((element) => react.createElement("div", { key: element.id, style: cardStyle },
                      react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
                        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                          react.createElement(Badge, { tone: "brand" }, element.key),
                          react.createElement("span", { style: { font: T.fontMono, fontSize: 11, color: T.labelTertiary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, element.selector),
                        ),
                        react.createElement("div", { style: { display: "flex", gap: 6, flex: "none" } },
                          react.createElement(Button, { onClick: () => setEditingElement({ element }) }, "编辑"),
                          react.createElement(Button, { variant: "danger", onClick: () => void removeElement(element) }, "删除"),
                        ),
                      ),
                      element.page ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `页面: ${element.page}`) : null,
                      element.description ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelTertiary } }, element.description) : null,
                    )),
                  ))),
        ),
        notice ? react.createElement("div", { style: {
          flex: "none", boxSizing: "border-box", padding: "8px 16px", borderTop: `1px solid ${T.borderL2}`,
          font: T.fontXxs, color: T.success, background: T.successTint,
        } }, notice) : null,
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
      );
    }


    // ── 报告视图 ──────────────────────────────────────────────────────────

    function ReportsView(props) {
      const sessionId = props.sessionId;
      const workspace = props.useWorkspaces((state) =>
        state.items.find((item) => item.sessionIds?.includes(sessionId)),
      );
      const workspaceId = workspace?.workspaceId ?? null;
      const [reports, setReports] = useState([]);
      const [selected, setSelected] = useState(null); // null=列表, {id}=详情
      const [trimmedView, setTrimmedView] = useState(false); // 详情是否来自大报告的裁剪缓存
      const [mode, setMode] = useState("reports"); // reports | history
      const [history, setHistory] = useState([]);
      const [historyDetail, setHistoryDetail] = useState(null); // 展开的历史条目
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [confirm, setConfirm] = useState(null); // { message, onConfirm } 删除确认
      const [notice, setNotice] = useState(null); // 成功提示(替代 window.alert)
      // 报告筛选(一期)
      const [kindFilter, setKindFilter] = useState("");
      const [resultFilter, setResultFilter] = useState("");
      const [keyword, setKeyword] = useState("");
      // 详情对比(一期)与统计(一期/二期)
      const [compare, setCompare] = useState(null); // { hasPrevious, previous, diff }
      const [stats, setStats] = useState(null); // { interfaces, topFailedRequests, topFailedAssertions }
      // 迭代归因(二期):变更清单里 added/modified 的接口键,失败项命中时提示「本版本已变更」
      const [changedRequestKeys, setChangedRequestKeys] = useState(null);

      // 拉取变更清单,构建 `${METHOD} ${path}` 键集(报告详情归因用)。
      useEffect(() => {
        if (!workspaceId) return;
        let alive = true;
        (async () => {
          try {
            const response = await window.fetch(`${ROUTE_ROOT}/api/changelogs?workspaceId=${encodeURIComponent(workspaceId)}`);
            const data = await response.json();
            const keys = new Set();
            for (const changelog of data.changelogs ?? []) {
              for (const change of changelog.changedRequests ?? []) {
                if (change.change === "removed") continue;
                const path = matchPath(change.url);
                if (path) keys.add(`${String(change.method ?? "GET").toUpperCase()} ${path}`);
              }
            }
            if (alive) setChangedRequestKeys(keys);
          } catch { /* 清单不可用时不显示归因 */ }
        })();
        return () => { alive = false; };
      }, [workspaceId]);

      const refresh = async () => {
        setLoading(true);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/reports?workspaceId=${encodeURIComponent(workspaceId)}`);
          const data = await response.json();
          if (data.ok) setReports(data.reports ?? []);
          else setError(data.message);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const refreshHistory = async () => {
        setLoading(true);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/history?workspaceId=${encodeURIComponent(workspaceId)}`);
          const data = await response.json();
          if (data.ok) setHistory(data.history ?? []);
          else setError(data.message);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const refreshStats = async () => {
        setLoading(true);
        try {
          const [i, f] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/stats/interfaces?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
            window.fetch(`${ROUTE_ROOT}/api/stats/failures?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => r.json()),
          ]);
          if (i.ok && f.ok) setStats({ interfaces: i.interfaces ?? [], topFailedRequests: f.topFailedRequests ?? [], topFailedAssertions: f.topFailedAssertions ?? [] });
          else setError(i.message || f.message);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const openHistoryDetail = async (id) => {
        const response = await window.fetch(`${ROUTE_ROOT}/api/history/${id}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const data = await response.json();
        if (data.ok) setHistoryDetail(data.entry);
        else setError(data.message);
      };

      const openReport = async (id) => {
        const [r, c] = await Promise.all([
          window.fetch(`${ROUTE_ROOT}/api/reports/${id}?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()),
          window.fetch(`${ROUTE_ROOT}/api/reports/${id}/compare?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()),
        ]);
        if (r.ok) { setSelected(r.report); setTrimmedView(r.trimmed === true); }
        else setError(r.message);
        setCompare(c.ok ? c : null);
      };

      /**
       * 整理旧报告:裁剪超大正文 + 补侧车索引(有损:断言 actual 只保留预览)。
       * 用于修复历史遗留的数百 MB 报告 —— 它们会让报告列表/详情变慢甚至拖垮宿主。
       */
      const migrateLegacy = async () => {
        setLoading(true); setNotice(null); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/reports/migrate-legacy`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setNotice(`旧报告已整理:处理 ${data.processed ?? 0} 份,裁剪 ${data.trimmed ?? 0} 份,回收 ${((data.reclaimedBytes ?? 0) / 1048576).toFixed(1)} MB`);
          void refresh();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const removeReport = (id) => {
        setConfirm({
          message: "删除这份报告?",
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/reports/${id}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) { setSelected(null); void refresh(); }
            else setError(data.message);
          },
        });
      };

      // hook 必须在条件提前 return 之前调用(React 规则)。
      useEffect(() => { if (workspaceId) { if (mode === "history") void refreshHistory(); else if (mode === "stats") void refreshStats(); else void refresh(); } }, [workspaceId, mode]);

      if (selected) {
        const summary = selected.summary ?? { total: 0, passed: 0, failed: 0 };
        const failed = summary.failed ?? 0;
        // 报告只保存统计信息与失败项,没有逐请求/断言明细可供图表聚合。
        const failedEntries = Array.isArray(selected.failedEntries) ? selected.failedEntries : [];
        const exportMarkdown = async () => {
          try {
            const response = await window.fetch(`${ROUTE_ROOT}/api/reports/${selected.id}/export?format=md&workspaceId=${encodeURIComponent(workspaceId)}`);
            if (!response.ok) { setError(`导出失败: HTTP ${response.status}`); return; }
            const text = await response.text();
            // 写入剪贴板,用户可粘贴到文档;同时提示已落盘 exports/。
            try { await navigator.clipboard.writeText(text); setError(null); } catch { /* 剪贴板不可用时忽略 */ }
            setNotice("Markdown 已复制到剪贴板,并保存到 test-mode/exports/ 目录");
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        };
        // 同系列趋势:同 kind+name 的所有报告按时间升序,通过率折线。
        const seriesPoints = reports
          .filter((r) => r.kind === selected.kind && r.name === selected.name)
          .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
          .map((r) => {
            const total = r.summary?.total ?? 0;
            const rate = total > 0 ? Math.round(((r.summary?.passed ?? 0) / total) * 100) : 0;
            const label = new Date(r.createdAt ?? '').toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            return { label, rate };
          });
        const rateOf = (s) => {
          const total = s?.total ?? 0;
          return total > 0 ? Math.round(((s?.passed ?? 0) / total) * 100) : 0;
        };
        return react.createElement("div", { style: rootStyle },
          react.createElement("div", { style: toolbarStyle },
            react.createElement(Button, { onClick: () => setSelected(null) }, "← 返回列表"),
            react.createElement("span", { style: toolbarTitle }, selected.name ?? "未命名报告"),
            react.createElement("span", { style: toolbarSpacer }),
            react.createElement(Button, { onClick: () => void exportMarkdown() }, "导出 Markdown"),
          ),
          react.createElement("div", { style: scrollStyle },
            react.createElement("div", { style: contentColumn },
              trimmedView
                ? react.createElement("div", { style: { ...cardStyle, gap: 4, borderColor: T.warn } },
                  react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "该报告体积过大,已按需裁剪展示"),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                    "断言 actual 只保留预览;可在报告列表点「整理旧报告」永久压缩,或直接删除该报告"))
                : null,
              // 与上次对比(一期):通过率Δ/新失败/耗时Δ
              compare?.hasPrevious
                ? react.createElement("div", { style: { ...cardStyle, gap: 8, borderColor: (compare.diff?.failedDelta ?? 0) > 0 ? T.error : T.success } },
                  react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
                    react.createElement(Badge, { tone: "brand" }, "与上次对比"),
                    react.createElement(Badge, { tone: (compare.diff?.failedDelta ?? 0) > 0 ? "error" : "success" },
                      `通过率 ${rateOf(compare.previous?.summary)}% → ${rateOf(summary)}%`),
                    react.createElement(Badge, { tone: (compare.diff?.failedDelta ?? 0) > 0 ? "error" : "success" },
                      `失败 ${compare.diff?.failedDelta ?? 0}${(compare.diff?.failedDelta ?? 0) > 0 ? " ↑" : (compare.diff?.failedDelta ?? 0) < 0 ? " ↓" : ""}`),
                    react.createElement(Badge, null,
                      `耗时 ${(((compare.diff?.durationDeltaMs ?? 0) / 1000).toFixed(1))}s ${(compare.diff?.durationDeltaMs ?? 0) > 0 ? "↑" : "↓"}`),
                    compare.diff?.fixedCount > 0 ? react.createElement(Badge, { tone: "success" }, `修复 ${compare.diff.fixedCount} 个`) : null,
                  ),
                  (compare.diff?.newFailures ?? []).length > 0
                    ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                      react.createElement("span", { style: { font: T.fontXxs, color: T.error } }, `新失败 ${compare.diff.newFailures.length} 个:`),
                      compare.diff.newFailures.slice(0, 10).map((failure, i) => react.createElement("span", { key: i, style: { font: T.fontMono, fontSize: 11, color: T.labelSecondary, wordBreak: "break-all" } },
                        `${failure.method ?? ""} ${failure.url ?? ""}${failure.error ? ` — ${failure.error}` : ""}`)),
                    )
                    : react.createElement("span", { style: { font: T.fontXxs, color: T.success } }, "没有新增失败"),
                )
                : null,
              // 汇总条:总数/通过/失败/耗时
              react.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 120, alignItems: "center", gap: 2 } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500, color: T.labelPrimary } }, summary.total ?? 0),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "总数"),
                ),
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 120, alignItems: "center", gap: 2 } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500, color: T.success } }, summary.passed ?? 0),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "通过"),
                ),
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 120, alignItems: "center", gap: 2 } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500, color: failed > 0 ? T.error : T.labelTertiary } }, failed),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "失败"),
                ),
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 120, alignItems: "center", gap: 2 } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500, color: T.labelPrimary } }, `${(selected.durationMs ?? 0).toFixed(0)}ms`),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "耗时"),
                ),
              ),
              // 图表区:通过率环形图(报告只保存统计,不做逐请求分布)
              react.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
                react.createElement("div", { style: { ...cardStyle, flex: "0 0 200px" } },
                  react.createElement("span", { style: fieldLabel }, "通过率"),
                  react.createElement(DonutChart, { total: summary.total ?? 0, passed: summary.passed ?? 0 }),
                ),
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 260, gap: 6 } },
                  react.createElement("span", { style: fieldLabel }, `失败项${failedEntries.length > 0 ? `(${failedEntries.length})` : ""}`),
                  failedEntries.length === 0
                    ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "没有失败项")
                    : react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                      failedEntries.slice(0, 50).map((entry, index) => react.createElement("div", { key: index, style: { display: "flex", alignItems: "center", gap: 6, font: T.fontXxs, flexWrap: "wrap" } },
                        react.createElement(Badge, { tone: "error" },
                          entry.kind === "case" ? "用例" : entry.kind === "collection" ? "集合" : entry.kind === "ui" ? "UI" : entry.kind === "step" ? "步骤" : "请求"),
                        react.createElement("span", { style: { color: T.labelSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "55%" } },
                          entry.label ?? ""),
                        entry.method ? react.createElement(MethodBadge, { method: entry.method }) : null,
                        typeof entry.status === "number" ? react.createElement(Badge, null, `HTTP ${entry.status}`) : null,
                        changedRequestKeys && entry.url && changedRequestKeys.has(`${String(entry.method ?? "GET").toUpperCase()} ${matchPath(entry.url) ?? ""}`)
                          ? react.createElement(Badge, { tone: "warn", title: "该接口出现在本版本变更清单中:先确认期望值是否随版本更新,再判断是否缺陷" }, "本版本已变更")
                          : null,
                        entry.error ? react.createElement("span", { style: { color: T.error } }, entry.error) : null,
                      )),
                      failedEntries.length > 50
                        ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `仅显示前 50 项,共 ${failedEntries.length} 项`)
                        : null,
                      selected.failuresTruncated > 0
                        ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `另有 ${selected.failuresTruncated} 个失败项未记录`)
                        : null,
                    ),
                ),
              ),
              react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                "报告只保存统计信息与失败项,不保存执行过程明细(请求/响应体、断言 actual、UI 步骤等不落盘)。"),
              // 回归趋势(二期):同系列通过率折线
              seriesPoints.length >= 2
                ? react.createElement("div", { style: { ...cardStyle, gap: 8 } },
                  react.createElement("span", { style: fieldLabel }, "回归趋势(同系列通过率)"),
                  react.createElement(TrendChart, { points: seriesPoints }),
                )
                : null,
              react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                `开始于 ${new Date(selected.startedAt ?? selected.createdAt).toLocaleString()}`),

            ),
          ),
          notice ? react.createElement("div", { style: {
            flex: "none", boxSizing: "border-box", padding: "8px 16px", borderTop: `1px solid ${T.borderL2}`,
            font: T.fontXxs, color: T.success, background: T.successTint,
          } }, notice) : null,
          confirm ? react.createElement(ConfirmDialog, {
            message: confirm.message,
            onConfirm: () => void confirm.onConfirm(),
            onCancel: () => setConfirm(null),
          }) : null,
        );
      }



      // 报告筛选(一期):kind / 结果 / 关键词。
      const kindLabel = { request: '单请求', case: '用例', collection: '集合', plan: '计划', ui: 'UI', legacy: '旧报告' };
      const visibleReports = (reports ?? []).filter((report) => {
        if (kindFilter && report.kind !== kindFilter) return false;
        if (resultFilter === "pass" && (report.summary?.failed ?? 0) > 0) return false;
        if (resultFilter === "fail" && (report.summary?.failed ?? 0) === 0) return false;
        if (keyword) {
          const haystack = `${report.name ?? ""} ${report.kind ?? ""}`.toLowerCase();
          if (!haystack.includes(keyword.toLowerCase())) return false;
        }
        return true;
      });

      const tabButton = (target, label) => react.createElement(Button, {
        onClick: () => { setMode(target); setHistoryDetail(null); setSelected(null); },
        style: {
          height: 24,
          padding: "0 10px",
          borderRadius: 6,
          font: T.fontXxs,
          fontWeight: mode === target ? 600 : 500,
          color: mode === target ? T.labelPrimary : T.labelTertiary,
          background: mode === target ? T.hover : "transparent",
        },
      }, label);

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          tabButton("reports", "报告"),
          tabButton("history", "历史"),
          tabButton("stats", "统计"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            mode === "history" ? `${history.length}` : (mode === "stats" ? (stats ? `${stats.interfaces?.length ?? 0} 个接口` : "") : `${reports.length}`)),
          react.createElement("span", { style: toolbarSpacer }),
        ),
        mode === "reports"
          ? react.createElement("div", { style: {
            display: "flex", flex: "none", alignItems: "center", gap: 8,
            boxSizing: "border-box", width: "100%", padding: "8px 16px",
            borderBottom: `1px solid ${T.borderL1}`, background: T.bgLayer1,
          } },
            react.createElement("input", {
              style: { ...inputStyle, flex: 1, minWidth: 100, font: T.fontXxs },
              placeholder: "搜索报告名称…",
              value: keyword,
              onChange: (e) => setKeyword(e.target.value),
            }),
            react.createElement("select", { style: { ...inputStyle, width: "auto", font: T.fontXxs }, value: kindFilter,
              onChange: (e) => setKindFilter(e.target.value) },
              react.createElement("option", { value: "" }, "类型:全部"),
              Object.entries(kindLabel).map(([value, label]) => react.createElement("option", { key: value, value }, label))),
            react.createElement("select", { style: { ...inputStyle, width: "auto", font: T.fontXxs }, value: resultFilter,
              onChange: (e) => setResultFilter(e.target.value) },
              react.createElement("option", { value: "" }, "结果:全部"),
              react.createElement("option", { value: "pass" }, "全部通过"),
              react.createElement("option", { value: "fail" }, "有失败"),
            ),
            react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
              visibleReports.length !== (reports ?? []).length ? `${visibleReports.length}/${reports.length}` : `${reports.length}`),
            react.createElement(Button, {
              onClick: () => void migrateLegacy(),
              disabled: (reports ?? []).every((report) => report.legacy !== true),
              title: "把体积过大的旧报告裁剪为摘要(断言 actual 只保留预览)并为全部旧报告建立索引,可回收大量磁盘;关闭按钮表示没有待整理的旧报告",
            }, (reports ?? []).some((report) => report.legacy === true) ? "整理旧报告" : "旧报告已整理"),
          )
          : null,
        react.createElement("div", { style: scrollStyle },
          error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
          loading ? react.createElement("div", { style: emptyStyle }, "加载中…")
            : mode === "history"
              ? (history.length === 0
                ? react.createElement("div", { style: emptyStyle }, "还没有执行历史")
                : react.createElement("div", { style: contentColumn },
                  history.map((entry) => react.createElement("div", { key: entry.id, style: cardStyle },
                    react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
                      react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                        react.createElement(Badge, { tone: entry.kind === "request" ? "brand" : (entry.kind === "case" ? "warn" : "success") },
                          entry.kind === "request" ? "请求" : (entry.kind === "case" ? "用例" : "集合")),
                        react.createElement("strong", { style: { font: T.fontXsStrong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                          entry.name ?? ""),
                      ),
                      react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flex: "none" } },
                        entry.pass === undefined
                          ? null
                          : react.createElement(Badge, { tone: entry.pass ? "success" : "error" }, entry.pass ? "PASS" : "FAIL"),
                        typeof entry.status === "number" ? react.createElement(Badge, null, `HTTP ${entry.status}`) : null,
                        react.createElement(Badge, null, `${(entry.durationMs ?? 0).toFixed(0)}ms`),
                        react.createElement(Badge, null, new Date(entry.createdAt ?? "").toLocaleString()),
                      ),
                    ),
                    entry.detail
                      ? react.createElement(Button, { onClick: () => void openHistoryDetail(entry.id), style: { alignSelf: "flex-start", height: 20, padding: "0 8px", font: T.fontXxs } },
                        historyDetail?.id === entry.id ? "收起详情" : "查看详情")
                      : null,
                    historyDetail?.id === entry.id ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, font: T.fontXxs } },
                      react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                        react.createElement(Badge, { tone: "brand" }, "请求"),
                        react.createElement("span", { style: { color: T.labelSecondary, font: T.fontMono, fontSize: 11, wordBreak: "break-all" } },
                          `${entry.detail.request?.method ?? ""} ${entry.detail.request?.url ?? ""}`),
                      ),
                      (entry.detail.request?.body !== undefined && entry.detail.request?.body !== null && entry.detail.request?.body !== "")
                        ? react.createElement("pre", { style: { font: T.fontMono, fontSize: 11, lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, padding: 6, borderRadius: 6, background: T.bgLayer2, color: T.labelSecondary, maxHeight: 160, overflowY: "auto" } },
                          typeof entry.detail.request.body === "string" ? entry.detail.request.body : JSON.stringify(entry.detail.request.body, null, 2))
                        : null,
                      react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
                        react.createElement(Badge, { tone: entry.detail.response?.status >= 400 ? "error" : "success" }, "响应"),
                        react.createElement("span", { style: { color: T.labelSecondary } }, `HTTP ${entry.detail.response?.status ?? "?"}`),
                        react.createElement("span", { style: { color: T.labelCaption } }, `${(entry.durationMs ?? 0).toFixed(0)}ms`),
                      ),
                      (entry.detail.response?.text)
                        ? react.createElement("pre", { style: { font: T.fontMono, fontSize: 11, lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, padding: 6, borderRadius: 6, background: T.bgLayer2, color: T.labelSecondary, maxHeight: 200, overflowY: "auto" } },
                          entry.detail.response.text)
                        : null,
                      (entry.detail.assertions ?? []).length
                        ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                          (entry.detail.assertions ?? []).map((a, i) => react.createElement("div", { key: i, style: { display: "flex", gap: 6, alignItems: "center" } },
                            react.createElement("span", { style: { flex: "none", width: 14, color: a.pass ? T.success : T.error, fontWeight: 700 } }, a.pass ? "✓" : "✗"),
                            react.createElement("span", { style: { color: T.labelSecondary } },
                              `${a.type ?? ""}${a.path ? ` ${a.path}` : ""} ${a.operator ?? ""} ${JSON.stringify(a.expected)}`),
                            react.createElement("span", { style: { color: T.labelCaption } }, `实际: ${JSON.stringify(a.actual)}`),
                          )),
                        )
                        : null,
                    ) : null,
                  )),
                ))
              : mode === "stats"
                ? react.createElement("div", { style: contentColumn },
                  react.createElement("div", { style: { ...cardStyle, gap: 8 } },
                    react.createElement("span", { style: { font: T.fontXsStrong, color: T.labelPrimary } }, "接口健康度"),
                    react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
                      "按接口聚合执行历史:成功率、平均耗时、最近结果;失败多的接口排前面(可配合「AI 生成 · 缺口 mock」补测试)"),
                    (stats?.interfaces ?? []).length === 0
                      ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "还没有接口执行数据,跑一些请求/集合后刷新")
                      : react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                        (stats.interfaces ?? []).map((iface) => react.createElement("div", { key: `${iface.method}-${iface.url}`, style: { display: "flex", alignItems: "center", gap: 8 } },
                          react.createElement(MethodBadge, { method: iface.method }),
                          react.createElement("span", { style: { font: T.fontMono, fontSize: 11, color: T.labelSecondary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, iface.url),
                          react.createElement(Badge, { tone: iface.successRate >= 100 ? "success" : (iface.successRate >= 60 ? "warn" : "error") }, `${iface.successRate}%`),
                          react.createElement(Badge, null, `${iface.failed}/${iface.total} 失败`),
                          react.createElement(Badge, null, `${iface.avgDurationMs}ms`),
                          iface.lastPass === undefined
                            ? null
                            : react.createElement(Badge, { tone: iface.lastPass ? "success" : "error" }, iface.lastPass ? "最近通过" : "最近失败"),
                        )),
                      ),
                  ),
                  react.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
                    react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 240 } },
                      react.createElement("span", { style: fieldLabel }, "失败接口 Top(按失败次数)"),
                      (stats?.topFailedRequests ?? []).length === 0
                        ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "没有失败记录")
                        : react.createElement(BarChart, { items: (stats.topFailedRequests ?? []).map((item) => ({ label: `${item.method} ${item.url}`, value: item.failCount })) }),
                    ),
                    react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 240 } },
                      react.createElement("span", { style: fieldLabel }, "失败断言 Top(按失败次数)"),
                      (stats?.topFailedAssertions ?? []).length === 0
                        ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "没有失败记录")
                        : react.createElement(BarChart, { items: (stats.topFailedAssertions ?? []).map((item) => ({ label: item.label, value: item.failCount })) }),
                    ),
                  ),
                  react.createElement(Button, { onClick: () => void refreshStats(), style: { alignSelf: "flex-start" } }, "刷新统计"),
                )
              : (visibleReports.length === 0
                ? react.createElement("div", { style: emptyStyle }, "还没有执行报告,在「组件测试 → 接口」运行集合后生成")
                : react.createElement("div", { style: contentColumn },
                  visibleReports.map((report) => react.createElement("div", { key: report.id, style: cardStyle },
                    react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
                      react.createElement("strong", { style: { font: T.fontXsStrong, cursor: "pointer", color: T.labelPrimary },
                        onClick: () => void openReport(report.id) },
                        report.name ?? "未命名报告"),
                      report.legacy === true
                        ? react.createElement(Badge, { tone: "warn" }, report.size ? `旧报告 ${(report.size / 1048576).toFixed(0)}MB` : "旧报告")
                        : null,
                      react.createElement("div", { style: { display: "flex", gap: 6, alignItems: "center", flex: "none" } },
                        react.createElement(Badge, { tone: (report.summary?.failed ?? 0) > 0 ? "error" : "success" },
                          `${report.summary?.passed ?? 0}/${report.summary?.total ?? 0} 通过`),
                        react.createElement(Badge, null, `${(report.durationMs ?? 0).toFixed(0)}ms`),
                        react.createElement(Badge, null, new Date(report.createdAt ?? "").toLocaleString()),
                      ),
                    ),
                    react.createElement("div", { style: { display: "flex", gap: 6 } },
                      react.createElement(Button, { onClick: () => void openReport(report.id) }, "查看"),
                      react.createElement(Button, { variant: "danger", onClick: () => void removeReport(report.id) }, "删除"),
                    ),
                  )),
                )),
        ),
        notice ? react.createElement("div", { style: {
          flex: "none", boxSizing: "border-box", padding: "8px 16px", borderTop: `1px solid ${T.borderL2}`,
          font: T.fontXxs, color: T.success, background: T.successTint,
        } }, notice) : null,
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
      );
    }

    // ── 组件测试视图(接口 + UI 脚本) ─────────────────────────────────────
    /**
     * 组件测试:把原「API 测试」与「UI 自动化」合并为一个顶层标签,内部用子标签切换。
     * 子视图以嵌入模式渲染(隐藏各自标题,保留工具栏动作),状态互不干扰。
     */
    function ComponentTestView(props) {
      const [tab, setTab] = useState("api"); // api | ui
      const tabButton = (target, label) => react.createElement(Button, {
        onClick: () => setTab(target),
        style: {
          height: 24, padding: "0 10px", borderRadius: 6, font: T.fontXxs,
          fontWeight: tab === target ? 600 : 500,
          color: tab === target ? T.labelPrimary : T.labelTertiary,
          background: tab === target ? T.hover : "transparent",
        },
      }, label);
      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          react.createElement("span", { style: toolbarTitle }, "组件测试"),
          tabButton("api", "接口"),
          tabButton("ui", "UI 脚本"),
          react.createElement("span", { style: toolbarSpacer }),
        ),
        react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
          tab === "api"
            ? react.createElement(ApiTestView, { ...props, embedded: true })
            : react.createElement(UiAutomationView, { ...props, embedded: true }),
        ),
      );
    }

    // ── 测试资产库视图(树形清单 + 富编辑器) ────────────────────────────────
    /**
     * 资产库:左树(模块/集合 → 资产)+ 右侧编辑器。
     * 接口资产复用 RequestEditor(方法/URL/Headers/Query/Body/断言/变量提取/数据工厂),
     * UI 资产复用 UiStepEditor;保存走 PUT /api/assets/:id,执行走 POST /api/assets/run。
     */
    function AssetLibraryView(props) {
      const sessionId = props.sessionId;
      const workspace = props.useWorkspaces((state) => state.items.find((item) => item.sessionIds?.includes(sessionId)));
      const workspaceId = workspace?.workspaceId ?? null;
      const [tab, setTab] = useState("api"); // api | component | flow
      const [assets, setAssets] = useState([]);
      const [summary, setSummary] = useState(null);
      const [generators, setGenerators] = useState([]);
      const [elements, setElements] = useState([]);
      const [environments, setEnvironments] = useState([]);
      const [selectedId, setSelectedId] = useState(null);
      const [draft, setDraft] = useState(null);
      const [keyword, setKeyword] = useState("");
      // 状态快速筛选:'' | solid | stale | failed | untested(点汇总徽章切换)
      const [statusFilter, setStatusFilter] = useState("");
      // 标签筛选(空 = 全部)。
      const [tagFilter, setTagFilter] = useState("");
      // 目录折叠:模块与集合各自可折叠;默认只展开当前选中资产所在的目录(手风琴)。
      const [expandedModules, setExpandedModules] = useState([]);
      const [expandedCollections, setExpandedCollections] = useState([]);
      const collectionKey = (moduleName, collectionName) => `${moduleName}::${collectionName}`;
      const [envId, setEnvId] = useState("");
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [confirm, setConfirm] = useState(null);

      const refresh = async () => {
        setLoading(true);
        try {
          const [a, f, e, env] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/assets?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()),
            window.fetch(`${ROUTE_ROOT}/api/datafactory?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()).catch(() => ({ ok: false })),
            window.fetch(`${ROUTE_ROOT}/api/ui/elements?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()).catch(() => ({ ok: false })),
            window.fetch(`${ROUTE_ROOT}/api/environments?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()).catch(() => ({ ok: false })),
          ]);
          if (!a.ok) { setError(a.message); return; }
          setAssets(a.assets ?? []);
          setSummary(a.summary ?? null);
          if (f.ok) setGenerators(f.generators ?? []);
          if (e.ok) setElements(e.elements ?? []);
          if (env.ok) {
            setEnvironments(env.environments ?? []);
            if (!envId) setEnvId(env.defaultEnvironmentId ?? env.environments?.[0]?.id ?? "");
          }
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setLoading(false); }
      };
      useEffect(() => { if (workspaceId) void refresh(); }, [workspaceId]);

      const matchesTab = (asset) => tab === "api"
        ? asset.kind === "api"
        : asset.kind === "ui" && (asset.type ?? "flow") === tab;
      const searchVisible = (assets ?? []).filter(matchesTab).filter((asset) => {
        if (!keyword.trim()) return true;
        const haystack = `${asset.name ?? ""} ${asset.module ?? ""} ${(asset.tags ?? []).join(" ")} ${asset.request?.url ?? ""} ${asset.source?.collectionName ?? ""}`.toLowerCase();
        return haystack.includes(keyword.trim().toLowerCase());
      });
      const matchesTag = (asset) => tagFilter === "" || (asset.tags ?? []).includes(tagFilter);
      const tagVisible = searchVisible.filter(matchesTag);
      const matchesStatus = (asset) => statusFilter === ""
        || (statusFilter === "solid" ? asset.status === "solid" && asset.stale !== true
          : statusFilter === "stale" ? asset.status === "solid" && asset.stale === true
            : asset.status === statusFilter);
      const visible = tagVisible.filter(matchesStatus);
      const statusCounts = {
        solid: tagVisible.filter((asset) => asset.status === "solid" && asset.stale !== true).length,
        stale: tagVisible.filter((asset) => asset.status === "solid" && asset.stale === true).length,
        failed: tagVisible.filter((asset) => asset.status === "failed").length,
        untested: tagVisible.filter((asset) => asset.status === "untested").length,
      };
      const pending = tagVisible.filter((asset) => asset.status !== "solid" || asset.stale === true);
      // 标签候选(按出现次数排序,最多 12 个)
      const tagCounts = new Map();
      for (const asset of searchVisible) {
        for (const tag of asset.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
      const tagOptions = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 12);
      const groups = [];
      for (const asset of tagVisible) {
        const moduleName = asset.module || "未分组";
        const collectionName = asset.source?.collectionName || "未分组集合";
        let group = groups.find((item) => item.module === moduleName);
        if (!group) { group = { module: moduleName, collections: [] }; groups.push(group); }
        let collection = group.collections.find((item) => item.name === collectionName);
        if (!collection) { collection = { name: collectionName, items: [] }; group.collections.push(collection); }
        collection.items.push(asset);
      }

      const expandTo = (asset) => {
        const moduleName = asset.module || "未分组";
        const collectionName = asset.source?.collectionName || "未分组集合";
        setExpandedModules((prev) => (prev.includes(moduleName) ? prev : [moduleName]));
        setExpandedCollections((prev) => {
          const keyValue = collectionKey(moduleName, collectionName);
          if (prev.includes(keyValue)) return prev;
          return [...prev.filter((item) => !item.startsWith(`${moduleName}::`)), keyValue];
        });
      };
      const toggleModule = (moduleName) => {
        const willExpand = !expandedModules.includes(moduleName);
        setExpandedModules(willExpand ? [moduleName] : []);
        if (!willExpand) { setExpandedCollections([]); return; }
        // 展开模块时同时展开其第一个集合,避免逐级点击;其余集合仍可单独展开/折叠。
        const firstCollection = groups.find((group) => group.module === moduleName)?.collections?.[0]?.name;
        setExpandedCollections(firstCollection ? [collectionKey(moduleName, firstCollection)] : []);
      };
      const toggleCollection = (moduleName, collectionName) => {
        const keyValue = collectionKey(moduleName, collectionName);
        setExpandedModules((prev) => (prev.includes(moduleName) ? prev : [moduleName]));
        setExpandedCollections((prev) => (prev.includes(keyValue)
          ? prev.filter((item) => item !== keyValue)
          : [...prev.filter((item) => !item.startsWith(`${moduleName}::`)), keyValue]));
      };

      /** 状态筛选按钮:汇总徽章样式,点击切换筛选。 */
      const statusChip = (value, label, count, color) => react.createElement(Button, {
        "data-status-filter": value,
        onClick: () => setStatusFilter(statusFilter === value ? "" : value),
        style: { height: 22, padding: "0 8px", borderRadius: 5, font: T.fontXxs,
          color: statusFilter === value ? T.labelPrimary : color,
          fontWeight: statusFilter === value ? 600 : 500,
          background: statusFilter === value ? T.hover : "transparent" },
      }, `${label} ${count}`);
      /** 资产库标签筛选按钮。 */
      const tagChipButton = (value, label, active, onClick) => react.createElement(Button, {
        "data-filter-group": "tag",
        "data-filter-value": value,
        onClick,
        style: { height: 22, padding: "0 8px", borderRadius: 5, font: T.fontXxs,
          color: active ? T.labelPrimary : T.labelTertiary,
          fontWeight: active ? 600 : 500,
          background: active ? T.hover : "transparent" },
      }, label);
      const selectAsset = (asset) => {
        setSelectedId(asset.id);
        expandTo(asset);
        setDraft({
          name: asset.name ?? "", module: asset.module ?? "", tagsText: (asset.tags ?? []).join(", "),
          baseUrl: asset.baseUrl ?? "",
          request: { ...REQUEST_DEFAULTS, ...(asset.request ?? {}) },
          steps: Array.isArray(asset.steps) ? asset.steps : [],
          type: asset.type ?? (tab === "component" ? "component" : "flow"),
        });
        setNotice(null);
        setError(null);
      };
      // 切换标签时重置折叠,再自动展开到选中的资产。
      useEffect(() => {
        setExpandedModules([]);
        setExpandedCollections([]);
        setTagFilter("");
      }, [tab]);
      // 当前标签/搜索下没有选中项时,自动选中第一个可见资产(保证右侧编辑器有内容)
      useEffect(() => {
        const current = visible.find((asset) => asset.id === selectedId);
        if (current) { expandTo(current); return; }
        if (visible.length > 0) selectAsset(visible[0]);
        else { setSelectedId(null); setDraft(null); }
      }, [tab, keyword, assets.length, statusFilter, tagFilter]);

      const selected = (assets ?? []).find((asset) => asset.id === selectedId) ?? null;

      const tabButton = (target, label) => react.createElement(Button, {
        onClick: () => setTab(target),
        style: { height: 24, padding: "0 10px", borderRadius: 6, font: T.fontXxs,
          fontWeight: tab === target ? 600 : 500, color: tab === target ? T.labelPrimary : T.labelTertiary,
          background: tab === target ? T.hover : "transparent" },
      }, label);
      const statusColor = (asset) => asset.status === "solid"
        ? (asset.stale ? T.warn : T.success)
        : (asset.status === "failed" ? T.error : T.labelTertiary);

      /** 保存草稿到资产(PUT),返回保存后的资产。 */
      const saveDraft = async () => {
        if (!selected || !draft) return null;
        const payload = selected.kind === "api"
          ? { workspaceId, name: draft.name, module: draft.module, tags: splitTags(draft.tagsText), baseUrl: draft.baseUrl, request: draft.request }
          : { workspaceId, name: draft.name, module: draft.module, tags: splitTags(draft.tagsText), type: draft.type, steps: draft.steps };
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/assets/${encodeURIComponent(selected.id)}`, {
            method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return null; }
          setNotice("已保存(配置变更后资产视为过期,需重跑)");
          await refresh();
          return data.asset;
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); return null; }
      };

      const runSelected = async () => {
        if (!selected) return;
        setBusy("run"); setError(null); setNotice(null);
        try {
          const saved = draft ? await saveDraft() : null;
          const assetId = saved?.id ?? selected.id;
          const response = await window.fetch(`${ROUTE_ROOT}/api/assets/run`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, assetId, environmentId: envId || undefined }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          const pass = data.result?.pass === true;
          setNotice(`${pass ? "通过" : "失败"} — ${data.result?.name ?? assetId}${data.result?.error ? `:${data.result.error}` : ""}`);
          if (data.asset) { setAssets((prev) => prev.map((asset) => (asset.id === data.asset.id ? data.asset : asset))); selectAsset(data.asset); }
          await refresh();
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(null); }
      };

      const runPending = async () => {
        if (pending.length === 0) { setNotice("当前标签下没有待测资产"); return; }
        setBusy("__batch__"); setError(null);
        let ran = 0; let passed = 0;
        try {
          for (let round = 0; round < 100; round += 1) {
            const snapshot = await window.fetch(`${ROUTE_ROOT}/api/assets?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json());
            if (!snapshot.ok) { setError(snapshot.message); break; }
            const pendingNow = (snapshot.assets ?? []).filter((asset) => matchesTab(asset) && matchesTag(asset) && (asset.status !== "solid" || asset.stale === true));
            if (pendingNow.length === 0) break;
            const response = await window.fetch(`${ROUTE_ROOT}/api/assets/run-batch`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId, assetIds: pendingNow.slice(0, 20).map((asset) => asset.id), environmentId: envId || undefined }),
            });
            const data = await response.json();
            if (!data.ok) { setError(data.message); break; }
            const results = data.results ?? [];
            if (results.length === 0) break;
            ran += results.length;
            passed += results.filter((item) => item.pass === true).length;
            setNotice(`补测中… 已执行 ${ran} 个(通过 ${passed})`);
          }
          setNotice(`补测完成:执行 ${ran} 个,通过 ${passed} 个`);
          const fresh = await window.fetch(`${ROUTE_ROOT}/api/assets?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json());
          if (fresh.ok) setAssets(fresh.assets ?? []);
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(null); }
      };

      /** 生成 UI 资产粒度整改清单(Markdown,不改数据)。 */
      const generateGranularityReport = async () => {
        setBusy("__report__"); setError(null); setNotice(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/assets/granularity-report`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setNotice(`整改清单已生成:${data.path}(需整改 ${data.summary?.warningCount ?? 0} 项)`);
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(null); }
      };

      /** 为当前接口资产生成安全回归资产与工作项(先 dry-run 确认,再写入)。 */
      const scaffoldSecurity = async (asset) => {
        setBusy("__security__"); setError(null); setNotice(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/security/scaffold`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, assetIds: [asset.id] }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          const plan = data.plan ?? {};
          const names = [...(plan.assets ?? []).map((item) => item.name), ...(plan.workItems ?? []).map((item) => item.name)];
          if (names.length === 0) { setNotice("没有可生成的安全资产(可能已存在)"); return; }
          setConfirm({
            confirmText: "生成",
            message: `生成安全回归:${(plan.assets ?? []).length} 个安全资产 + ${(plan.workItems ?? []).length} 个工作项?\n${names.slice(0, 6).join("、")}${names.length > 6 ? " 等" : ""}`,
            onConfirm: async () => {
              setConfirm(null);
              const applyRes = await window.fetch(`${ROUTE_ROOT}/api/security/scaffold`, {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ workspaceId, assetIds: [asset.id], apply: true }),
              });
              const applied = await applyRes.json();
              if (!applied.ok) { setError(applied.message); return; }
              setNotice(`安全回归已生成:资产 ${applied.created?.assets ?? 0} 个、工作项 ${applied.created?.workItems ?? 0} 个`);
              await refresh();
            },
          });
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(null); }
      };

      const createAsset = async () => {
        const kind = tab === "api" ? "api" : "ui";
        setBusy("create"); setError(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/assets`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId, kind, ...(kind === "ui" ? { type: tab === "component" ? "component" : "flow" } : {}),
              name: "新资产", module: "未分组",
              ...(kind === "api" ? { baseUrl: "", request: { ...REQUEST_DEFAULTS } } : { steps: [] }),
            }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          await refresh();
          selectAsset(data.asset);
          setTab(kind === "api" ? "api" : (data.asset.type ?? "flow"));
        } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(null); }
      };

      const removeSelected = () => {
        if (!selected) return;
        setConfirm({
          message: `删除资产「${selected.name}」?`,
          onConfirm: async () => {
            setConfirm(null);
            const response = await window.fetch(`${ROUTE_ROOT}/api/assets/${encodeURIComponent(selected.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
            const data = await response.json();
            if (data.ok) { setSelectedId(null); setDraft(null); setNotice("资产已删除"); await refresh(); }
            else setError(data.message);
          },
        });
      };

      const splitTags = (textValue) => String(textValue ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
      const updateDraft = (patch) => setDraft((current) => (current ? { ...current, ...patch } : current));

      const renderDetail = () => {
        if (!draft || !selected) {
          return react.createElement("div", { style: emptyStyle }, visible.length === 0 ? "还没有资产:点「+ 新建资产」创建,或让智能体写入 assets/ 目录" : "选择左侧一个资产");
        }
        const statusText = selected.status === "solid"
          ? (selected.stale ? "已固化(配置已变更,需重跑)" : "已固化")
          : (selected.status === "failed" ? "失败" : "未测试");
        return react.createElement("div", { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto", padding: 14 } },
          react.createElement("div", { style: { ...cardStyle, gap: 8, maxWidth: 920 } },
            react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
              react.createElement(Badge, { tone: selected.status === "solid" ? (selected.stale ? "warn" : "success") : (selected.status === "failed" ? "error" : undefined) }, statusText),
              selected.stats ? react.createElement(Badge, null, `执行 ${selected.stats.runs ?? 0} 次(通过 ${selected.stats.passed ?? 0} / 失败 ${selected.stats.failed ?? 0})`) : null,
              selected.lastPassed?.at ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `上次通过 ${new Date(selected.lastPassed.at).toLocaleString()}`) : null,
              selected.source?.collectionName ? react.createElement(Badge, { tone: "brand" }, `集合 ${selected.source.collectionName}`) : null,
              react.createElement("span", { style: { flex: 1 } }),
              draft.type || selected.kind === "ui" ? react.createElement("select", { style: { ...inputStyle, width: 120, flex: "none" }, value: draft.type,
                onChange: (e) => updateDraft({ type: e.target.value }) },
                [["component", "UI 组件"], ["flow", "UI 流程"]].map(([value, label]) => react.createElement("option", { key: value, value }, label))) : null,
              environments.length > 0 ? react.createElement("select", { style: { ...inputStyle, width: 150, flex: "none" }, value: envId,
                onChange: (e) => setEnvId(e.target.value) },
                environments.map((env) => react.createElement("option", { key: env.id, value: env.id }, env.name))) : null,
              selected.kind === "api"
                ? react.createElement(Button, { onClick: () => void scaffoldSecurity(selected), disabled: busy !== null }, "生成安全回归")
                : null,
              react.createElement(Button, { onClick: () => void saveDraft(), disabled: busy !== null }, "保存"),
              react.createElement(Button, { variant: "primary", onClick: () => void runSelected(), disabled: busy !== null }, busy === "run" ? "执行中…" : "执行"),
              react.createElement(Button, { variant: "danger", onClick: () => void removeSelected() }, "删除"),
            ),
            react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
              react.createElement("input", { style: { ...inputStyle, flex: 2, minWidth: 200 }, placeholder: "资产名称", value: draft.name, onChange: (e) => updateDraft({ name: e.target.value }) }),
              react.createElement("input", { style: { ...inputStyle, flex: 1, minWidth: 120 }, placeholder: "模块(如 订单)", value: draft.module, onChange: (e) => updateDraft({ module: e.target.value }) }),
              react.createElement("input", { style: { ...inputStyle, flex: 1, minWidth: 120 }, placeholder: "标签,逗号分隔", value: draft.tagsText, onChange: (e) => updateDraft({ tagsText: e.target.value }) }),
              selected.kind === "api"
                ? react.createElement("input", { style: { ...inputStyle, flex: 2, minWidth: 200, font: T.fontMono, fontSize: 11 }, placeholder: "baseUrl(如 http://127.0.0.1:8000)", value: draft.baseUrl, onChange: (e) => updateDraft({ baseUrl: e.target.value }) })
                : null,
            ),
            selected.kind === "ui" && selected.granularity
              ? react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", font: T.fontXxs } },
                react.createElement(Badge, { tone: (selected.granularity.warnings ?? []).length > 0 ? "warn" : "success" },
                  `${selected.type === "component" ? "组件" : "流程"} ${selected.granularity.pages} 页 / ${selected.granularity.steps} 步 / ${selected.granularity.assertions} 断言`),
                (selected.granularity.warnings ?? []).length > 0
                  ? react.createElement("span", { style: { color: T.warn } },
                    `粒度提示:${selected.granularity.warnings.join(";")}${selected.granularity.suggestion ? `(建议:${selected.granularity.suggestion})` : ""}`)
                  : null)
              : null,
            (selected.securityWarnings ?? []).length > 0
              ? react.createElement("div", { style: { font: T.fontXxs, color: T.warn } },
                `安全提示:${selected.securityWarnings.join(";")}`)
              : null,
            (selected.tagWarnings ?? []).length > 0
              ? react.createElement("div", { style: { font: T.fontXxs, color: T.warn } },
                `标签提示:以下标签不在标签库:${selected.tagWarnings.join(", ")}(可在「基础配置 → 标签」添加)`)
              : null,
            selected.kind === "api"
              ? react.createElement(react.Fragment, null,
                selected.lastPassed?.request
                  ? react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                    react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "已固化接口可一键填回通过时的请求模板(变量保持占位符):"),
                    react.createElement(Button, { style: { height: 22, padding: "0 8px", font: T.fontXxs }, onClick: () => updateDraft({ request: { ...REQUEST_DEFAULTS, ...selected.lastPassed.request } }) }, "使用上次通过的数据"))
                  : null,
                react.createElement(RequestEditor, {
                  request: draft.request,
                  onChange: (request) => updateDraft({ request }),
                  onRun: () => void runSelected(),
                  running: busy === "run",
                  generators,
                  asset: selected,
                  project: selected.source?.projectId ? { id: selected.source.projectId, name: draft.module } : undefined,
                  collectionId: selected.source?.collectionId,
                  inputActions: props.inputActions,
                  useProjection: props.useProjection,
                  env: envId,
                }))
              : react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
                react.createElement(Section, {
                  title: `步骤(${draft.steps.length})`,
                  right: react.createElement("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
                    UI_STEP_KINDS.slice(0, 6).map((meta) => react.createElement(Button, {
                      key: meta.kind,
                      style: { height: 22, padding: "0 8px", font: T.fontXxs },
                      onClick: () => updateDraft({ steps: [...draft.steps, { kind: meta.kind, name: "" }] }),
                    }, `+ ${meta.label}`)),
                  ),
                },
                  draft.steps.length === 0
                    ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "还没有步骤:用上方按钮添加(open/click/type/断言…)")
                    : draft.steps.map((step, index) => react.createElement(UiStepEditor, {
                      key: index, step, index, elements,
                      onChange: (next) => updateDraft({ steps: draft.steps.map((item, i) => (i === index ? next : item)) }),
                      onRemove: () => updateDraft({ steps: draft.steps.filter((_, i) => i !== index) }),
                    }))),
              ),
            error ? react.createElement("div", { style: { color: T.error, font: T.fontXxs } }, error) : null,
            notice ? react.createElement("div", { style: { color: T.success, font: T.fontXxs } }, notice) : null,
          ),
        );
      };

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          react.createElement("span", { style: toolbarTitle }, "资产库"),
          tabButton("api", "接口"),
          tabButton("component", "UI 组件"),
          tabButton("flow", "UI 流程"),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, `${visible.length}`),
          react.createElement("span", { style: toolbarSpacer }),
          react.createElement(Button, { onClick: () => void runPending(), disabled: busy !== null || pending.length === 0 },
            busy === "__batch__" ? "补测中…" : `测试待测资产(${pending.length})`),
          react.createElement(Button, { onClick: () => void generateGranularityReport(), disabled: busy !== null }, "生成粒度整改清单"),
          react.createElement(Button, { variant: "primary", onClick: () => void createAsset(), disabled: busy !== null }, "+ 新建资产"),
          react.createElement(Button, { onClick: () => void refresh() }, "刷新"),
        ),
        react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "8px 16px", borderBottom: `1px solid ${T.borderL1}` } },
          statusChip("solid", "已固化", statusCounts.solid, T.success),
          statusChip("stale", "过期", statusCounts.stale, T.warn),
          statusChip("failed", "失败", statusCounts.failed, T.error),
          statusChip("untested", "未测试", statusCounts.untested, T.labelTertiary),
          statusFilter || tagFilter ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelTertiary } }, `筛选出 ${visible.length} 项(再点一次取消)`) : null,
          tagOptions.length > 0 ? react.createElement("span", { style: { width: 8 } }) : null,
          tagOptions.length > 0 ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "标签") : null,
          tagOptions.length > 0 ? tagChipButton("", "全部", tagFilter === "", () => setTagFilter("")) : null,
          tagOptions.map(([tag, count]) => tagChipButton(tag, `${tag} ${count}`, tagFilter === tag,
            () => setTagFilter(tagFilter === tag ? "" : tag))),
          react.createElement("span", { style: { flex: 1 } }),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "版本保存要求:全部资产已固化且无过期"),
        ),
        react.createElement("div", { style: { flex: 1, minHeight: 0, display: "flex" } },
          react.createElement("div", { style: { width: 300, flex: "none", borderRight: `1px solid ${T.borderL1}`, display: "flex", flexDirection: "column", minHeight: 0 } },
            react.createElement("div", { style: { padding: 8 } },
              react.createElement("input", { style: inputStyle, placeholder: "搜索资产名称/模块/标签/URL…", value: keyword, onChange: (e) => setKeyword(e.target.value) })),
            react.createElement("div", { style: { flex: 1, overflowY: "auto", padding: "0 8px 12px" } },
              loading ? react.createElement("div", { style: { ...emptyStyle, padding: 20 } }, "加载中…")
                : groups.length === 0
                  ? react.createElement("div", { style: { ...emptyStyle, padding: 20 } }, statusFilter ? "当前筛选下没有资产" : "没有匹配的资产")
                  : groups.map((group) => {
                    const moduleExpanded = keyword.trim() !== "" || expandedModules.includes(group.module);
                    const moduleCount = group.collections.reduce((sum, collection) => sum + collection.items.length, 0);
                    const moduleSolid = group.collections.reduce((sum, collection) => sum + collection.items.filter((asset) => asset.status === "solid" && asset.stale !== true).length, 0);
                    return react.createElement("div", { key: group.module, style: { display: "flex", flexDirection: "column", gap: 2, marginBottom: 8 } },
                      react.createElement("div", {
                        role: "button",
                        "data-testid": "asset-module",
                        "data-module": group.module,
                        title: moduleExpanded ? "折叠模块" : "展开模块",
                        onClick: () => toggleModule(group.module),
                        style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", font: T.fontXxs, color: T.labelTertiary, borderRadius: 6 },
                      },
                        react.createElement("span", { style: { width: 10, flex: "none", color: T.labelCaption } }, moduleExpanded ? "▾" : "▸"),
                        react.createElement("span", { style: { fontWeight: 600, color: T.labelSecondary } }, group.module),
                        react.createElement("span", { title: `已固化 ${moduleSolid} / 共 ${moduleCount}(不含过期)` },
                          react.createElement("span", { style: { color: T.success } }, `${moduleSolid}`),
                          react.createElement("span", { style: { color: T.labelCaption } }, `/${moduleCount}`))),
                      moduleExpanded ? group.collections.map((collection) => {
                        const collectionAssets = collection.items.filter(matchesStatus);
                        if (statusFilter && collectionAssets.length === 0) return null;
                        const keyValue = collectionKey(group.module, collection.name);
                        const collectionExpanded = keyword.trim() !== "" || expandedCollections.includes(keyValue);
                        return react.createElement("div", { key: collection.name, style: { display: "flex", flexDirection: "column", gap: 1, paddingLeft: 8 } },
                          react.createElement("div", {
                            role: "button",
                            "data-testid": "asset-collection",
                            "data-collection": collection.name,
                            title: collectionExpanded ? "折叠集合" : "展开集合",
                            onClick: () => toggleCollection(group.module, collection.name),
                            style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 6px", font: T.fontXxs, color: T.labelCaption, borderRadius: 6 },
                          },
                            react.createElement("span", { style: { width: 10, flex: "none" } }, collectionExpanded ? "▾" : "▸"),
                            react.createElement("span", null, collection.name),
                            react.createElement("span", {
                              title: `已固化 ${collection.items.filter((asset) => asset.status === "solid" && asset.stale !== true).length} / 共 ${collection.items.length}(不含过期)`,
                            },
                              react.createElement("span", { style: { color: T.success } }, `${collection.items.filter((asset) => asset.status === "solid" && asset.stale !== true).length}`),
                              react.createElement("span", { style: { color: T.labelCaption } }, `/${collection.items.length}`))),
                          collectionExpanded ? collectionAssets.map((asset) => react.createElement("div", {
                        key: asset.id, role: "button", "data-testid": "asset-row", "data-asset-id": asset.id, onClick: () => selectAsset(asset),
                        style: { display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 6, cursor: "default",
                          background: asset.id === selectedId ? T.hover : "transparent", minHeight: 24, marginLeft: 6 },
                      },
                        react.createElement("span", { title: asset.status === "solid" ? (asset.stale ? "已过期" : "已固化") : (asset.status === "failed" ? "失败" : "未测试"),
                          style: { width: 7, height: 7, borderRadius: "50%", flex: "none", background: statusColor(asset) } }),
                        asset.kind === "api"
                          ? react.createElement(MethodBadge, { method: asset.request?.method ?? "GET" })
                          : react.createElement(Badge, { tone: "brand" }, asset.type === "component" ? "UI 组件" : "UI 流程"),
                        react.createElement("span", { title: `${asset.name ?? asset.id} ${asset.request?.url ?? ""}`, style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: T.fontXxs, color: asset.id === selectedId ? T.labelPrimary : T.labelSecondary } },
                          asset.name ?? asset.id),
                          asset.status !== "solid" ? react.createElement("span", { style: { font: T.fontXxs, color: statusColor(asset), flex: "none" } },
                            asset.status === "failed" ? "失败" : "未测试") : (asset.stale ? react.createElement("span", { style: { font: T.fontXxs, color: T.warn, flex: "none" } }, "过期") : null),
                          (asset.kind === "ui" && (asset.granularity?.warnings ?? []).length > 0) || (asset.securityWarnings ?? []).length > 0
                            ? react.createElement("span", {
                              title: [...(asset.granularity?.warnings ?? []), ...(asset.securityWarnings ?? [])].join(";"),
                              style: { color: T.warn, flex: "none", font: T.fontXxs },
                            }, "⚠")
                            : null,
                        )) : null,
                        );
                      }) : null,
                    );
                  }),
            ),
          ),
          renderDetail(),
        ),
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          confirmText: confirm.confirmText,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
      );
    }

    // ── 测试工作项视图(功能/e2e/性能/安全 四类) ─────────────────────────────
    /** 测试工作项类型(四个标签页)。 */
    const WORK_ITEM_TABS = [
      { value: "functional", label: "功能测试" },
      { value: "e2e", label: "e2e测试" },
      { value: "performance", label: "性能测试" },
      { value: "security", label: "安全测试" },
    ];
    /** 优先级选项。 */
    const WORK_ITEM_PRIORITIES = [
      { value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" },
    ];
    /** 自动化状态选项。 */
    const WORK_ITEM_AUTOMATION = [
      { value: "manual", label: "手工" }, { value: "auto", label: "自动化" }, { value: "partial", label: "半自动" },
    ];
    /** 结果选项。 */
    const WORK_ITEM_RESULTS = [
      { value: "not_run", label: "未执行" }, { value: "passed", label: "通过" }, { value: "failed", label: "失败" },
      { value: "blocked", label: "阻塞" }, { value: "skipped", label: "跳过" },
    ];
    /** 结果 → Badge 色调。 */
    const workItemResultTone = (result) => (result === "passed" ? "success" : result === "failed" ? "error" : result === "blocked" ? "warn" : undefined);
    /** 自动化状态 → 文案。 */
    const workItemAutomationLabel = (value) => WORK_ITEM_AUTOMATION.find((item) => item.value === (value ?? "manual"))?.label ?? "手工";

    /**
     * 测试工作项:四个测试类型标签页;工作项 = 资产组合 + 标题/优先级/需求/自动化状态/结果/缺陷。
     */
    function AssetCasesView(props) {
      const sessionId = props.sessionId;
      const workspace = props.useWorkspaces((state) => state.items.find((item) => item.sessionIds?.includes(sessionId)));
      const workspaceId = workspace?.workspaceId ?? null;
      const [tab, setTab] = useState("functional");
      const [cases, setCases] = useState([]);
      const [assets, setAssets] = useState([]);
      const [keyword, setKeyword] = useState("");
      // 快速筛选:执行结果 / 优先级 / 标签(空 = 全部)。
      const [resultFilter, setResultFilter] = useState("");
      const [priorityFilter, setPriorityFilter] = useState("");
      const [tagFilter, setTagFilter] = useState("");
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [result, setResult] = useState(null);
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState(null);
      const [confirm, setConfirm] = useState(null);
      // 工作项卡片默认紧凑显示,点击展开详情。
      const [expandedId, setExpandedId] = useState(null);

      const refresh = async () => {
        setLoading(true);
        try {
          const [c, a] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/cases?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()),
            window.fetch(`${ROUTE_ROOT}/api/assets?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()),
          ]);
          if (c.ok) setCases(c.cases ?? []); else setError(c.message);
          if (a.ok) setAssets(a.assets ?? []);
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setLoading(false); }
      };
      useEffect(() => { if (workspaceId) void refresh(); }, [workspaceId]);

      const itemType = (testCase) => testCase.type ?? "functional";
      const tabCases = (cases ?? []).filter((testCase) => itemType(testCase) === tab);
      const tagCounts = new Map();
      for (const testCase of tabCases) {
        for (const tag of testCase.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
      const tagOptions = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, 12);
      const visible = tabCases.filter((testCase) => {
        if (resultFilter && (testCase.result ?? "not_run") !== resultFilter) return false;
        if (priorityFilter && (testCase.priority ?? "medium") !== priorityFilter) return false;
        if (tagFilter && !(testCase.tags ?? []).includes(tagFilter)) return false;
        if (!keyword.trim()) return true;
        const haystack = `${testCase.name ?? ""} ${testCase.module ?? ""} ${testCase.requirement ?? ""} ${(testCase.tags ?? []).join(" ")} ${(testCase.defects ?? []).join(" ")}`.toLowerCase();
        return haystack.includes(keyword.trim().toLowerCase());
      });
      const filtersActive = resultFilter !== "" || priorityFilter !== "" || tagFilter !== "";
      const countOf = (typeValue) => (cases ?? []).filter((testCase) => itemType(testCase) === typeValue).length;

      const runCase = async (testCase) => {
        setBusy(testCase.id); setError(null); setResult(null);
        try {
          const response = await window.fetch(`${ROUTE_ROOT}/api/cases/${encodeURIComponent(testCase.id)}/run`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setResult({ ...data.result, name: data.result?.name ?? testCase.name });
          const failed = data.result?.summary?.failed ?? 0;
          setNotice(failed === 0 ? `工作项通过:${testCase.name}` : `工作项失败:${failed} 个资产/步骤未通过`);
          void refresh();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(null); }
      };

      const saveCase = async (payload) => {
        setError(null);
        try {
          const existing = editing?.testCase;
          const response = await window.fetch(`${ROUTE_ROOT}/api/cases${existing ? `/${encodeURIComponent(existing.id)}` : ""}`, {
            method: existing ? "PUT" : "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, ...payload }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); return; }
          setEditing(null); setNotice(existing ? "工作项已保存" : "工作项已创建");
          if (itemType(data.case) !== tab) setTab(itemType(data.case));
          void refresh();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      };

      const removeCase = (testCase) => setConfirm({
        message: `删除工作项「${testCase.name}」?`,
        onConfirm: async () => {
          setConfirm(null);
          const response = await window.fetch(`${ROUTE_ROOT}/api/cases/${encodeURIComponent(testCase.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
          const data = await response.json();
          if (data.ok) { setNotice("工作项已删除"); void refresh(); } else setError(data.message);
        },
      });

      if (editing) {
        return react.createElement(WorkItemEditor, {
          testCase: editing.testCase ?? null, defaultType: tab, assets, workspaceId, onSave: saveCase, onCancel: () => setEditing(null),
        });
      }

      const assetById = new Map((assets ?? []).map((asset) => [asset.id, asset]));
      /** 快速筛选按钮(结果/优先级),带 data 属性供测试定位。 */
      const filterChip = (group, value, label, active, onClick) => react.createElement(Button, {
        key: `${group}:${value}`,
        "data-filter-group": group,
        "data-filter-value": value,
        onClick,
        style: { height: 22, padding: "0 8px", borderRadius: 5, font: T.fontXxs,
          fontWeight: active ? 600 : 500, color: active ? T.labelPrimary : T.labelTertiary,
          background: active ? T.hover : "transparent" },
      }, label);
      const tabButton = (target, label) => react.createElement(Button, {
        onClick: () => { setTab(target); setExpandedId(null); setTagFilter(""); },
        style: { height: 24, padding: "0 10px", borderRadius: 6, font: T.fontXxs,
          fontWeight: tab === target ? 600 : 500, color: tab === target ? T.labelPrimary : T.labelTertiary,
          background: tab === target ? T.hover : "transparent" },
      }, `${label} ${countOf(target)}`);

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          react.createElement("span", { style: toolbarTitle }, "测试工作项"),
          WORK_ITEM_TABS.map((item) => tabButton(item.value, item.label)),
          react.createElement("span", { style: toolbarSpacer }),
          react.createElement(Button, { variant: "primary", onClick: () => setEditing({ testCase: null }) }, "+ 新建工作项"),
          react.createElement(Button, { onClick: () => void refresh() }, "刷新"),
        ),
        react.createElement("div", { style: { display: "flex", gap: 10, padding: "8px 16px", borderBottom: `1px solid ${T.borderL1}`, flexWrap: "wrap", alignItems: "center" } },
          react.createElement("input", { style: { ...inputStyle, maxWidth: 280 }, placeholder: "搜索标题/模块/需求/缺陷…", value: keyword, onChange: (e) => setKeyword(e.target.value) }),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "结果"),
          filterChip("result", "", "全部", resultFilter === "", () => setResultFilter("")),
          WORK_ITEM_RESULTS.map((item) => filterChip("result", item.value, item.label, resultFilter === item.value,
            () => setResultFilter(resultFilter === item.value ? "" : item.value))),
          react.createElement("span", { style: { width: 8 } }),
          react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "优先级"),
          filterChip("priority", "", "全部", priorityFilter === "", () => setPriorityFilter("")),
          WORK_ITEM_PRIORITIES.map((item) => filterChip("priority", item.value, item.label, priorityFilter === item.value,
            () => setPriorityFilter(priorityFilter === item.value ? "" : item.value))),
          tagOptions.length > 0 ? react.createElement("span", { style: { width: 8 } }) : null,
          tagOptions.length > 0 ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "标签") : null,
          tagOptions.length > 0 ? filterChip("tag", "", "全部", tagFilter === "", () => setTagFilter("")) : null,
          tagOptions.map(([tag, count]) => filterChip("tag", tag, `${tag} ${count}`, tagFilter === tag,
            () => setTagFilter(tagFilter === tag ? "" : tag))),
          filtersActive ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelTertiary } }, `筛选出 ${visible.length} 项`) : null,
        ),
        react.createElement("div", { style: scrollStyle },
          error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
          loading ? react.createElement("div", { style: emptyStyle }, "加载中…")
            : visible.length === 0
              ? react.createElement("div", { style: emptyStyle }, `「${WORK_ITEM_TABS.find((item) => item.value === tab)?.label ?? ""}」下还没有工作项:点「+ 新建工作项」,由资产组合而成`)
              : react.createElement("div", { style: contentColumn },
                visible.map((testCase) => {
                  const entries = Array.isArray(testCase.assets) ? testCase.assets : [];
                  const defects = Array.isArray(testCase.defects) ? testCase.defects : [];
                  const expanded = expandedId === testCase.id;
                  const priorityLabel = WORK_ITEM_PRIORITIES.find((item) => item.value === (testCase.priority ?? "medium"))?.label ?? "中";
                  const resultLabel = WORK_ITEM_RESULTS.find((item) => item.value === (testCase.result ?? "not_run"))?.label ?? "未执行";
                  return react.createElement("div", {
                    key: testCase.id,
                    "data-testid": "work-item-card",
                    "data-id": testCase.id,
                    onClick: () => setExpandedId(expanded ? null : testCase.id),
                    style: { ...cardStyle, padding: "7px 12px", gap: 2 },
                  },
                    // 第 1 行:标题 + 优先级 + 结果 + 关联缺陷(紧凑)
                    react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                      react.createElement("span", { style: { width: 10, flex: "none", font: T.fontXxs, color: T.labelCaption } }, expanded ? "▾" : "▸"),
                      react.createElement("strong", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: T.fontXs } },
                        testCase.name ?? testCase.id),
                      react.createElement(Badge, null, `优先级 ${priorityLabel}`),
                      react.createElement(Badge, { tone: workItemResultTone(testCase.result ?? "not_run") }, `结果:${resultLabel}`),
                      defects.slice(0, 2).map((defect) => react.createElement(Badge, { key: defect, tone: "error", title: "关联缺陷" }, defect)),
                      defects.length > 2 ? react.createElement(Badge, { tone: "error" }, `+${defects.length - 2}`) : null),
                    // 第 2 行:关联需求 + 自动化状态 + 资产数(截断)
                    react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, font: T.fontXxs, color: T.labelCaption, minWidth: 0, paddingLeft: 18 } },
                      react.createElement("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                        `需求: ${testCase.requirement || "(未关联)"}`),
                      react.createElement("span", { style: { flex: "none" } }, workItemAutomationLabel(testCase.automation)),
                      entries.length > 0 ? react.createElement("span", { style: { flex: "none" } }, `${entries.length} 个资产`) : null),
                    expanded ? react.createElement("div", {
                      style: { display: "flex", flexDirection: "column", gap: 6, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.borderL2}` },
                    },
                      react.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", font: T.fontXxs, color: T.labelCaption } },
                        react.createElement("span", null, `类型: ${WORK_ITEM_TABS.find((item) => item.value === (testCase.type ?? "functional"))?.label ?? "功能测试"}`),
                        react.createElement("span", null, `自动化状态: ${workItemAutomationLabel(testCase.automation)}`),
                        testCase.module ? react.createElement("span", null, `模块: ${testCase.module}`) : null,
                        (testCase.tags ?? []).length > 0 ? react.createElement("span", null, `标签: ${(testCase.tags ?? []).join(", ")}`) : null),
                      react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", font: T.fontXxs, color: T.labelCaption } },
                        react.createElement("span", null, "关联需求:"),
                        react.createElement("span", { style: { color: T.labelSecondary } }, testCase.requirement || "(未关联)")),
                      react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", font: T.fontXxs, color: T.labelCaption } },
                        react.createElement("span", null, "关联缺陷:"),
                        defects.length > 0
                          ? defects.map((defect) => react.createElement(Badge, { key: defect, tone: "error" }, defect))
                          : react.createElement("span", null, "(无)")),
                      entries.length > 0
                        ? react.createElement("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                          entries.map((entry, index) => {
                            const asset = assetById.get(entry.assetId);
                            return react.createElement(Badge, { key: `${entry.assetId}-${index}`, tone: "brand" },
                              `${asset?.name ?? entry.assetId}${asset?.status === "solid" && !asset.stale ? " ✓" : asset?.status === "failed" ? " ✗" : ""}`);
                          }))
                        : react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "没有资产组合(手工工作项)"),
                      react.createElement("div", { style: { display: "flex", gap: 6 }, onClick: (e) => e.stopPropagation() },
                        react.createElement(Button, { variant: "primary", onClick: () => void runCase(testCase), disabled: busy !== null }, busy === testCase.id ? "执行中…" : "执行"),
                        react.createElement(Button, { onClick: () => setEditing({ testCase }) }, "编辑"),
                        react.createElement(Button, { variant: "danger", onClick: () => void removeCase(testCase) }, "删除")),
                    ) : null,
                  );
                }),
                result ? react.createElement("div", { style: { ...cardStyle, gap: 6, borderColor: (result.summary?.failed ?? 0) > 0 ? T.error : T.success } },
                  react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    react.createElement("span", { style: { font: T.fontXsStrong } }, `工作项执行:${result.name}`),
                    react.createElement(Badge, { tone: (result.summary?.failed ?? 0) > 0 ? "error" : "success" }, `${result.summary?.passed ?? 0}/${result.summary?.total ?? 0} 通过`),
                    react.createElement(Badge, null, `${(result.durationMs ?? 0).toFixed(0)}ms`),
                  ),
                  (result.results ?? []).map((entry, index) => react.createElement("div", { key: index, style: { display: "flex", alignItems: "center", gap: 8, font: T.fontXxs } },
                    react.createElement("span", { style: { flex: "none", width: 16, color: entry.pass ? T.success : T.error, fontWeight: 700 } }, entry.pass ? "✓" : (entry.skipped ? "–" : "✗")),
                    react.createElement("span", { style: { color: T.labelSecondary } }, entry.name ?? entry.assetId ?? `步骤 ${index + 1}`),
                    entry.status ? react.createElement(Badge, null, `HTTP ${entry.status}`) : null,
                    entry.error ? react.createElement("span", { style: { color: T.error } }, entry.error) : null,
                  )),
                ) : null,
                notice ? react.createElement("div", { style: { font: T.fontXxs, color: T.success } }, notice) : null,
              ),
        ),
        confirm ? react.createElement(ConfirmDialog, {
          message: confirm.message,
          onConfirm: () => void confirm.onConfirm(),
          onCancel: () => setConfirm(null),
        }) : null,
      );
    }

    /** 工作项编辑:标题/类型/优先级/需求/自动化状态/结果/缺陷 + 资产组合。 */
    function WorkItemEditor(props) {
      const { testCase, defaultType, assets, onSave, onCancel } = props;
      const [name, setName] = useState(testCase?.name ?? "");
      const [type, setType] = useState(testCase?.type ?? defaultType ?? "functional");
      const [priority, setPriority] = useState(testCase?.priority ?? "medium");
      const [requirement, setRequirement] = useState(testCase?.requirement ?? "");
      const [automation, setAutomation] = useState(testCase?.automation ?? "manual");
      const [resultValue, setResultValue] = useState(testCase?.result ?? "not_run");
      const [defectsText, setDefectsText] = useState((testCase?.defects ?? []).join(", "));
      const [moduleName, setModuleName] = useState(testCase?.module ?? "");
      const [tagsText, setTagsText] = useState((testCase?.tags ?? []).join(", "));
      const [selected, setSelected] = useState(Array.isArray(testCase?.assets) ? testCase.assets.map((entry) => entry.assetId) : []);
      const [keyword, setKeyword] = useState("");
      const [error, setError] = useState(null);
      const toggle = (assetId) => setSelected((current) => current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]);
      const move = (index, delta) => setSelected((current) => {
        const next = [...current];
        const target = index + delta;
        if (target < 0 || target >= next.length) return current;
        const [item] = next.splice(index, 1);
        next.splice(target, 0, item);
        return next;
      });
      const visibleAssets = (assets ?? []).filter((asset) => !keyword || `${asset.name} ${asset.module ?? ""} ${(asset.tags ?? []).join(" ")}`.toLowerCase().includes(keyword.toLowerCase()));
      const save = () => {
        setError(null);
        if (!name.trim()) { setError("标题不能为空"); return; }
        onSave({
          name: name.trim(), type, priority, requirement, automation, result: resultValue,
          defects: defectsText.split(",").map((item) => item.trim()).filter(Boolean),
          module: moduleName.trim(), tags: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean),
          assets: selected.map((assetId) => ({ assetId })),
        });
      };
      const selectField = (label, value, setValue, options) => react.createElement("div", { style: { flex: 1, minWidth: 130 } },
        react.createElement("div", { style: fieldLabel }, label),
        react.createElement("select", { style: inputStyle, value, onChange: (e) => setValue(e.target.value) },
          options.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label))));
      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          react.createElement(Button, { onClick: onCancel }, "← 返回工作项"),
          react.createElement("span", { style: toolbarTitle }, testCase ? "编辑工作项" : "新建工作项"),
          react.createElement(Badge, { tone: "brand" }, WORK_ITEM_TABS.find((item) => item.value === type)?.label ?? ""),
        ),
        react.createElement("div", { style: scrollStyle },
          react.createElement("div", { style: { ...contentColumn, maxWidth: 1000 } },
            react.createElement(Section, { title: "基本信息" },
              react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                react.createElement("input", { style: { ...inputStyle, flex: 2, minWidth: 240 }, placeholder: "标题", value: name, onChange: (e) => setName(e.target.value) }),
                selectField("类型", type, setType, WORK_ITEM_TABS),
                selectField("优先级", priority, setPriority, WORK_ITEM_PRIORITIES),
                selectField("自动化状态", automation, setAutomation, WORK_ITEM_AUTOMATION),
                selectField("结果", resultValue, setResultValue, WORK_ITEM_RESULTS),
              ),
              react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                react.createElement("div", { style: { flex: 2, minWidth: 240 } },
                  react.createElement("div", { style: fieldLabel }, "关联需求"),
                  react.createElement("input", { style: inputStyle, placeholder: "需求编号 / 链接 / 描述", value: requirement, onChange: (e) => setRequirement(e.target.value) })),
                react.createElement("div", { style: { flex: 1, minWidth: 160 } },
                  react.createElement("div", { style: fieldLabel }, "模块"),
                  react.createElement("input", { style: inputStyle, placeholder: "如 订单", value: moduleName, onChange: (e) => setModuleName(e.target.value) })),
                react.createElement("div", { style: { flex: 1, minWidth: 160 } },
                  react.createElement("div", { style: fieldLabel }, "标签"),
                  react.createElement("input", { style: inputStyle, placeholder: "逗号分隔", value: tagsText, onChange: (e) => setTagsText(e.target.value) })),
              ),
              react.createElement("div", null,
                react.createElement("div", { style: fieldLabel }, "关联缺陷(票号 / 链接)"),
                react.createElement("input", { style: inputStyle, placeholder: "逗号分隔,如 #473, https://github.com/…/issues/474", value: defectsText, onChange: (e) => setDefectsText(e.target.value) })),
            ),
            react.createElement(Section, { title: `资产组合(按顺序执行):已选 ${selected.length} 个` },
              selected.length > 0 ? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
                selected.map((assetId, index) => react.createElement("div", { key: assetId, style: { display: "flex", alignItems: "center", gap: 6, font: T.fontXxs } },
                  react.createElement(Badge, { tone: "brand" }, `${index + 1}`),
                  react.createElement("span", { style: { flex: 1 } }, `${assets.find((asset) => asset.id === assetId)?.name ?? assetId}`),
                  react.createElement(Button, { onClick: () => move(index, -1), style: { height: 20, padding: "0 6px" } }, "↑"),
                  react.createElement(Button, { onClick: () => move(index, 1), style: { height: 20, padding: "0 6px" } }, "↓"),
                  react.createElement(Button, { onClick: () => toggle(assetId), style: { height: 20, padding: "0 6px" } }, "移除"),
                )),
              ) : react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "还没有选择资产"),
            ),
            react.createElement(Section, { title: "从资产库选择" },
              react.createElement("input", { style: inputStyle, placeholder: "搜索资产名称/模块/标签…", value: keyword, onChange: (e) => setKeyword(e.target.value) }),
              react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 300, overflowY: "auto" } },
                visibleAssets.map((asset) => react.createElement("label", { key: asset.id, style: { display: "flex", alignItems: "center", gap: 8, font: T.fontXxs } },
                  react.createElement("input", { type: "checkbox", checked: selected.includes(asset.id), onChange: () => toggle(asset.id) }),
                  react.createElement(Badge, { tone: "brand" }, asset.kind === "api" ? "API" : (asset.type === "component" ? "UI 组件" : "UI 流程")),
                  react.createElement("span", null, asset.name ?? asset.id),
                  asset.module ? react.createElement(Badge, null, asset.module) : null,
                )),
                visibleAssets.length === 0 ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "没有匹配的资产") : null,
              ),
            ),
            error ? react.createElement("div", { style: { color: T.error, font: T.fontXxs } }, error) : null,
            react.createElement("div", { style: { display: "flex", gap: 8 } },
              react.createElement(Button, { variant: "primary", onClick: save }, "保存"),
              react.createElement(Button, { onClick: onCancel }, "取消"),
            ),
          ),
        ),
      );
    }

    // ── 版本视图(系统测试报告) ───────────────────────────────────────────
    function VersionsView(props) {
      const sessionId = props.sessionId;
      const workspace = props.useWorkspaces((state) => state.items.find((item) => item.sessionIds?.includes(sessionId)));
      const workspaceId = workspace?.workspaceId ?? null;
      const [versions, setVersions] = useState([]);
      const [pending, setPending] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [selected, setSelected] = useState(null);
      const [compare, setCompare] = useState(null);
      const [failing, setFailing] = useState(null);
      const [confirm, setConfirm] = useState(null);
      // 可选安全门禁:保存版本时要求安全类工作项全部通过。
      const [requireSecurity, setRequireSecurity] = useState(false);

      const refresh = async () => {
        setLoading(true);
        try {
          const [v, p] = await Promise.all([
            window.fetch(`${ROUTE_ROOT}/api/versions?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()),
            window.fetch(`${ROUTE_ROOT}/api/assets/pending?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json()),
          ]);
          if (v.ok) setVersions(v.versions ?? []); else setError(v.message);
          if (p.ok) setPending(p.counts);
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setLoading(false); }
      };
      useEffect(() => { if (workspaceId) void refresh(); }, [workspaceId]);

      const runFullTest = async () => {
        setBusy(true); setError(null); setNotice(null); setFailing(null);
        let ran = 0; let passed = 0;
        try {
          for (let round = 0; round < 200; round += 1) {
            const snapshot = await window.fetch(`${ROUTE_ROOT}/api/assets/pending?workspaceId=${encodeURIComponent(workspaceId)}`).then((res) => res.json());
            if (!snapshot.ok) { setError(snapshot.message); break; }
            const ids = (snapshot.assets ?? []).map((asset) => asset.id);
            if (ids.length === 0) break;
            setNotice(`全量测试中… 已执行 ${ran} 个,通过 ${passed} 个,剩余 ${ids.length} 个`);
            const response = await window.fetch(`${ROUTE_ROOT}/api/assets/run-batch`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspaceId, assetIds: ids.slice(0, 20) }),
            });
            const data = await response.json();
            if (!data.ok) { setError(data.message); break; }
            const results = data.results ?? [];
            if (results.length === 0) break;
            ran += results.length;
            passed += results.filter((item) => item.pass === true).length;
          }
          setNotice(`全量测试完成:执行 ${ran} 个,通过 ${passed} 个`);
          void refresh();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const saveVersion = async () => {
        setBusy(true); setError(null); setNotice(null); setFailing(null);
        try {
          const name = `全量系统测试 ${new Date().toLocaleString()}`;
          const response = await window.fetch(`${ROUTE_ROOT}/api/versions`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId, name }),
          });
          const data = await response.json();
          if (!data.ok) { setError(data.message); setFailing(data.failing ?? []); return; }
          setNotice(`版本已保存:${data.version.name}`);
          void refresh();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const openVersion = async (version) => {
        setSelected(version); setCompare(null);
        const response = await window.fetch(`${ROUTE_ROOT}/api/versions/${encodeURIComponent(version.id)}/compare?workspaceId=${encodeURIComponent(workspaceId)}`);
        const data = await response.json();
        setCompare(data.ok ? data : null);
      };

      const removeVersion = (version) => setConfirm({
        message: `删除版本「${version.name}」?`,
        onConfirm: async () => {
          setConfirm(null);
          const response = await window.fetch(`${ROUTE_ROOT}/api/versions/${encodeURIComponent(version.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE" });
          const data = await response.json();
          if (data.ok) { if (selected?.id === version.id) setSelected(null); setNotice("版本已删除"); void refresh(); } else setError(data.message);
        },
      });

      if (selected) {
        return react.createElement("div", { style: rootStyle },
          react.createElement("div", { style: toolbarStyle },
            react.createElement(Button, { onClick: () => setSelected(null) }, "← 返回版本列表"),
            react.createElement("span", { style: toolbarTitle }, selected.name),
            react.createElement("span", { style: toolbarSpacer }),
            react.createElement(Button, { variant: "danger", onClick: () => void removeVersion(selected) }, "删除版本"),
          ),
          react.createElement("div", { style: scrollStyle },
            react.createElement("div", { style: contentColumn },
              react.createElement("div", { style: { display: "flex", gap: 10, flexWrap: "wrap" } },
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 140, alignItems: "center" } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500 } }, selected.summary?.total ?? 0),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "资产总数")),
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 140, alignItems: "center" } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500, color: T.success } }, selected.summary?.passed ?? 0),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "通过")),
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 140, alignItems: "center" } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500, color: selected.summary?.failed > 0 ? T.error : T.labelTertiary } }, selected.summary?.failed ?? 0),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "失败")),
                react.createElement("div", { style: { ...cardStyle, flex: 1, minWidth: 140, alignItems: "center" } },
                  react.createElement("span", { style: { font: T.fontXl, fontWeight: 500 } }, `${selected.coverage?.assetsExecuted ?? 0}/${selected.coverage?.assetsTotal ?? 0}`),
                  react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } }, "覆盖")),
              ),
              compare?.hasPrevious ? react.createElement("div", { style: { ...cardStyle, gap: 6 } },
                react.createElement("span", { style: { font: T.fontXsStrong } }, "与上一版本对比"),
                react.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", font: T.fontXxs } },
                  react.createElement(Badge, { tone: (compare.diff?.passedDelta ?? 0) >= 0 ? "success" : "error" }, `通过 ${compare.diff?.passedDelta >= 0 ? "+" : ""}${compare.diff?.passedDelta ?? 0}`),
                  react.createElement(Badge, { tone: (compare.diff?.failedDelta ?? 0) <= 0 ? "success" : "error" }, `失败 ${compare.diff?.failedDelta >= 0 ? "+" : ""}${compare.diff?.failedDelta ?? 0}`),
                  react.createElement(Badge, null, `资产 ${compare.diff?.assetsDelta >= 0 ? "+" : ""}${compare.diff?.assetsDelta ?? 0}`),
                ),
              ) : null,
              react.createElement("div", { style: { ...cardStyle, gap: 6 } },
                react.createElement("span", { style: { font: T.fontXsStrong } }, "按模块"),
                (selected.byModule ?? []).map((entry) => react.createElement("div", { key: entry.module, style: { display: "flex", gap: 8, font: T.fontXxs } },
                  react.createElement("span", { style: { flex: 1 } }, entry.module),
                  react.createElement(Badge, { tone: "success" }, `通过 ${entry.passed}/${entry.total}`),
                )),
              ),
              (selected.failedAssets ?? []).length > 0
                ? react.createElement("div", { style: { ...cardStyle, gap: 6, borderColor: T.error } },
                  react.createElement("span", { style: { font: T.fontXsStrong, color: T.error } }, `失败资产(${selected.failedAssets.length})`),
                  selected.failedAssets.map((asset) => react.createElement("div", { key: asset.assetId, style: { display: "flex", gap: 8, font: T.fontXxs } },
                    react.createElement("span", { style: { flex: 1 } }, asset.name ?? asset.assetId),
                    asset.error ? react.createElement("span", { style: { color: T.error } }, asset.error) : null,
                  )),
                )
                : null,
            ),
          ),
          confirm ? react.createElement(ConfirmDialog, { message: confirm.message, onConfirm: () => void confirm.onConfirm(), onCancel: () => setConfirm(null) }) : null,
        );
      }

      return react.createElement("div", { style: rootStyle },
        react.createElement("div", { style: toolbarStyle },
          react.createElement("span", { style: toolbarTitle }, "版本"),
          pending ? react.createElement("span", { style: { font: T.fontXxs, color: T.labelCaption } },
            `待测资产 ${pending.pending ?? 0} / 共 ${pending.total ?? 0}`) : null,
          react.createElement("span", { style: toolbarSpacer }),
          react.createElement(Button, { onClick: () => void runFullTest(), disabled: busy }, busy ? "执行中…" : "发起全量系统测试"),
          react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 4, font: T.fontXxs, color: T.labelSecondary } },
            react.createElement("input", {
              type: "checkbox", checked: requireSecurity,
              onChange: (e) => setRequireSecurity(e.target.checked),
              title: "启用后,安全测试 tab 的工作项必须全部通过才允许保存版本",
            }),
            "要求安全测试通过"),
          react.createElement(Button, { variant: "primary", onClick: () => void saveVersion(), disabled: busy }, "保存为版本"),
          react.createElement(Button, { onClick: () => void refresh() }, "刷新"),
        ),
        react.createElement("div", { style: scrollStyle },
          error ? react.createElement("div", { style: { ...emptyStyle, color: T.error } }, error) : null,
          failing && failing.length > 0 ? react.createElement("div", { style: { ...cardStyle, gap: 4, borderColor: T.error } },
            react.createElement("span", { style: { font: T.fontXsStrong, color: T.error } }, `还不能保存版本:${failing.length} 个资产未通过或已过期`),
            failing.slice(0, 20).map((asset) => react.createElement("div", { key: asset.id, style: { display: "flex", gap: 8, font: T.fontXxs } },
              react.createElement(Badge, { tone: (asset.status === "failed" || asset.result === "failed") ? "error" : "warn" },
                asset.stale ? "过期" : (asset.status === "failed" || asset.result === "failed" ? "失败" : (asset.result ? `结果:${asset.result}` : "未测试"))),
              react.createElement("span", null, asset.name ?? asset.id),
            )),
          ) : null,
          notice ? react.createElement("div", { style: { font: T.fontXxs, color: T.success } }, notice) : null,
          loading ? react.createElement("div", { style: emptyStyle }, "加载中…")
            : versions.length === 0
              ? react.createElement("div", { style: emptyStyle }, "还没有版本:先「发起全量系统测试」,所有资产通过后「保存为版本」(版本即系统测试报告)")
              : react.createElement("div", { style: contentColumn },
                versions.map((version) => react.createElement("div", { key: version.id, style: cardStyle },
                  react.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 } },
                    react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
                      react.createElement("strong", { style: { font: T.fontXsStrong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, version.name),
                      react.createElement(Badge, { tone: "success" }, `${version.summary?.passed ?? 0}/${version.summary?.total ?? 0} 通过`),
                      react.createElement(Badge, null, new Date(version.createdAt ?? "").toLocaleString()),
                    ),
                    react.createElement("div", { style: { display: "flex", gap: 6, flex: "none" } },
                      react.createElement(Button, { onClick: () => void openVersion(version) }, "查看"),
                      react.createElement(Button, { variant: "danger", onClick: () => void removeVersion(version) }, "删除"),
                    ),
                  ),
                )),
              ),
        ),
        confirm ? react.createElement(ConfirmDialog, { message: confirm.message, onConfirm: () => void confirm.onConfirm(), onCancel: () => setConfirm(null) }) : null,
      );
    }

    // ── 视图注册 ──────────────────────────────────────────────────────────

    /**
     * 非测试模式会话的占位页。标签栏是全局的(同一注册服务所有会话),会话门控
     * 必须在组件内做:agentPreset 是宿主会话投影,按会话读取(不是会话列表字段)。
     */
    const withTestModeGate = (label, Component) => function TestModeGatedView(props) {
      const preset = props.useProjection?.("agentPreset");
      const isTestMode = preset === undefined || preset === null || preset === TEST_MODE_PRESET_ID;
      if (!isTestMode) {
        return react.createElement("div", {
          style: { display: "flex", flexDirection: "column", gap: 6, alignItems: "center", justifyContent: "center", height: "100%", padding: 32, color: T.labelCaption, textAlign: "center" },
        },
          react.createElement("span", { style: { font: T.fontXs, color: T.labelSecondary } }, `「${label}」仅在测试模式会话中可用`),
          react.createElement("span", { style: { font: T.fontXxs } }, "请在会话模式选择器中选择「测试模式」(或新建一个测试模式会话)后使用"),
        );
      }
      return react.createElement(Component, props);
    };

    const views = [
      { id: "dsh-test-mode-environments", label: "基础配置", order: 30, component: EnvironmentView },
      { id: "dsh-test-mode-assets", label: "资产库", order: 31, component: AssetLibraryView },
      { id: "dsh-test-mode-cases", label: "测试工作项", order: 32, component: AssetCasesView },
      { id: "dsh-test-mode-versions", label: "版本", order: 33, component: VersionsView },
    ].map((view) => ({ ...view, component: withTestModeGate(view.label, view.component) }));

    const inject = ["slots"];

    const apply = (ctx) => {
      // conversation.view 的名册是全局投影(不按会话过滤),而标签条由按会话渲染的
      // 会话头部绘制。要还原「只在测试模式会话显示本插件标签」,就在会话头部的
      // utilities(list 槽,条目渲染 null 即不可见)挂一个感知条目:它随标签条一同
      // 挂载/卸载,在 effect 里读当前会话的 agentPreset 投影,注册或注销本插件视图。
      let desired = false;
      let registered = null;
      const reconcile = () => {
        if (desired === (registered !== null)) return;
        if (desired) {
          registered = views.map((view) => ctx.slots.register({
            name: "conversation.view",
            id: view.id,
            order: view.order,
            label: view.label,
          }, view.component));
          return;
        }
        for (const dispose of registered) dispose();
        registered = null;
      };
      const viewGate = ({ useProjection }) => {
        const enabled = useProjection("agentPreset") === TEST_MODE_PRESET_ID;
        react.useEffect(() => {
          desired = enabled;
          reconcile();
        }, [enabled]);
        return null;
      };
      ctx.slots.inject("conversation.view", () => {
        reconcile();
        return () => {
          if (registered === null) return;
          for (const dispose of registered) dispose();
          registered = null;
        };
      });
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "dsh-test-mode-view-gate",
        order: 100,
      }, viewGate));
    };

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
