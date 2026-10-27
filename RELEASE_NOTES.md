# dsh-test-mode v0.2.2

支持 **DSH 桌面版(0.2.1-rc.x)**;仍兼容 0.1.7-rc.2 起的客户端契约。

## 变更

- **peer 范围放宽到 `<0.3.0-0`**:桌面版 harness 为 0.2.1-rc.3,原范围(`<0.2.0-0`)会挡住安装;
  客户端契约(renderer/conversation/session/workspace + `slots.inject`/`conversation.view`/
  会话头部探针/`useProjection`)在 0.2.1-rc.3 上已逐项核对可用;
- 冒烟测试改为**自动解析 harness 包根**(`DSH_HARNESS_ROOT` 优先,其次探测 npx 缓存/旧 App 路径/checkout),
  找不到时明确跳过而不是崩溃(桌面版把 harness 打进 `app.asar` 后 shell 不可读)。

## 安装(桌面版)

```
# 装进 desktop profile
dsh plugin --profile desktop add ./dsh-test-mode
# 或手工:在 ~/.dsh/profiles/desktop/package.json 的 dependencies 加
#   "@calwang414/dsh-test-mode": "file:<本地 tarball>"
# 并把 "@calwang414/dsh-test-mode" 加入 dsh.profile.bundles,然后 pnpm install
```

重启桌面版 App 后,会话模式选择器出现「测试模式」,选中后 7 个标签页可用。

## 安装(Web / npx 版)

```
dsh plugin --profile web add https://github.com/calwang414/dsh-test-mode/releases/download/v0.2.2/dsh-test-mode-0.2.2.tgz
```
