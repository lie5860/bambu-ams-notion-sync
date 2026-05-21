# bambu-ams-notion-sync

把 Bambu Lab AMS 读到的物理耗材数据同步到 Notion。

项目维护一张 `AMS 耗材` 表，按 RFID tag UID 记录耗材余量、材料、颜色、重量和最后同步时间。你原来的 `耗材管理` 表继续保持人工主表；后续可以在 Notion 里用 Relation 把 `耗材管理` 和 `AMS 耗材` 关联起来。

## 同步到 Notion 的字段

脚本会查找或创建一个独立的子数据库页面 `AMS 耗材`，默认字段固定如下：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `RFID Tag UID` | Title | 主键，来自 AMS 的 `tag_uid` |
| `余量%` | Number | AMS 上报的剩余百分比 |
| `剩余克数` | Number | 按余量和标称重量估算 |
| `材料` | Rich text | 例如 `PLA Basic` |
| `颜色` | Rich text | 十六进制颜色 |
| `料盘重量g` | Number | AMS 上报的 `tray_weight`，默认 1000g |
| `Tray UUID` | Rich text | Bambu 上报的另一个物理耗材/料盘识别值 |
| `最后同步时间` | Date | 最近一次同步时间 |

不会默认写入 AMS 槽位、当前是否在设备、打印机名等设备上下文字段。

每条 `AMS 耗材` 页面还会被设置一个真实色号生成的小色块 icon，例如：

```text
https://dummyimage.com/64x64/C12E1F/C12E1F.png
```

Notion 的 Relation 选择器通常会显示页面 icon，所以在 `耗材管理` 里关联 `AMS 耗材` 时，可以通过色块识别颜色，通过标题识别材料和 RFID。标题格式为：

```text
PLA Basic · C6A86FCC
```

## Tray UUID 是什么

`tag_uid` 是 RFID 标签 UID，更适合做“这卷耗材”的主键。

`tray_uuid` 是 Bambu 在 AMS 数据里同时上报的另一个识别值。社区 Spoolman 项目常用它来绑定原厂 Bambu 料盘；它更像 Bambu 体系里给这卷耗材/托盘生成的内部 UUID。它不是槽位，槽位是 A0/A1/A2/A3。这里保留 `Tray UUID` 只是为了排查和兼容，主键仍然是 `RFID Tag UID`。

## 安装

```bash
npm install
cp .env.example .env
```

## 1. 初始化 Bambu Cloud token

推荐使用云端模式，因为打印机不在当前局域网时也能同步。

启动本地登录页面：

```bash
npm run cloud:login
```

打开终端里显示的地址，通常是：

```text
http://127.0.0.1:3030
```

在页面里选择区域并登录：

- 国内账号选 `China`
- 海外账号选 `Global`
- 支持手机号或邮箱
- 如果需要验证码，页面会继续让你输入短信/邮箱验证码

登录成功后会生成：

```text
.bambu-cloud.json
```

这个文件保存 Bambu Cloud 的 uid、access token、broker 和设备列表，不保存密码。它已经在 `.gitignore` 里。

页面会显示打印机 Serial，把它填入 `.env`：

```bash
BAMBU_CONNECTION_MODE=cloud
BAMBU_PRINTER_SERIAL=22E8BJ5C2801961
```

## 2. 配置 Notion token

去 Notion 的 [My integrations](https://www.notion.so/my-integrations) 创建一个 integration。

复制 `Internal Integration Secret`，填入 `.env`：

```bash
NOTION_TOKEN=secret_xxx
```

然后打开你的 `3D Print` 页面，把这个 integration 加到页面的 Connections 里。这个步骤很重要，不加的话 API 会看不到页面和数据库。

## 3. 配置 Notion 页面 ID

复制你的目标页面链接，取里面的 32 位 ID，或者直接填带标题的那段也可以。例如：

```bash
NOTION_DATA_SOURCE_ID=3D-Print-32880976a83a80e2b72eccaadd999c52
```

这个值可以是：

- Notion 页面 ID
- database ID
- data source ID

如果填的是页面 ID，脚本会在这个页面里查找或创建独立子数据库页面 `AMS 耗材`。

## 4. 第一次 dry-run

保持 `.env` 里的：

```bash
DRY_RUN=true
```

启动：

```bash
npm start
```

日志会显示它会创建或更新哪些 Notion 行，但不会真正写入。

也可以只测试 Bambu MQTT，不碰 Notion：

```bash
npm run debug:bambu
```

## 5. 正式同步

确认 dry-run 输出没问题后，把 `.env` 改成：

```bash
DRY_RUN=false
```

然后启动：

```bash
npm start
```

服务会监听 Bambu MQTT report，并按 `RFID Tag UID` upsert 到 `AMS 耗材`。

## 最小配置示例

```bash
BAMBU_CONNECTION_MODE=cloud
BAMBU_PRINTER_SERIAL=22E8BJ5C2801961

NOTION_TOKEN=secret_xxx
NOTION_DATA_SOURCE_ID=3D-Print-32880976a83a80e2b72eccaadd999c52

DRY_RUN=true
```

## 本地 MQTT 模式

如果你想完全不走云端，也可以用本地模式。脚本所在机器必须能访问打印机局域网 IP：

```bash
BAMBU_CONNECTION_MODE=local
BAMBU_PRINTER_IP=192.168.1.100
BAMBU_PRINTER_SERIAL=01PXXXXXXXXXXXX
BAMBU_ACCESS_CODE=12345678
```

## Docker

```bash
docker compose up -d --build
docker logs -f bambu-ams-notion-sync
```

## 默认行为

- 默认用 `tag_uid` 做主键；如果某个 tray 没有 `tag_uid`，才回退到 `tray_uuid`。
- `remain` 和 `tray_weight` 来自 Bambu/AMS 上报，脚本不自己计算转速。
- `PUSHALL_INTERVAL_MS` 默认 300000，也就是每 5 分钟请求一次完整状态。
- Notion 字段名默认固定，不需要在 `.env` 里配置。
