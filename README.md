# bambu-ams-notion-sync

把 Bambu Lab AMS 读到的耗材 RFID、余量、材料和颜色同步到 Notion。

项目会维护一个独立的 Notion 子数据库 `AMS 耗材`。你原来的 `耗材管理` 表继续作为人工主表；在 Notion 里给它加 Relation 关联 `AMS 耗材` 后，就可以按 RFID 绑定真实耗材。

## 推荐用法：Docker + Web 控制台

用仓库自带的 `docker-compose.yml` 启动服务：

```bash
docker compose up -d --build
```

打开：

```text
http://localhost:3030
```

在网页里完成这几件事：

1. 用 `Bambu Cloud 登录` 登录拓竹账号。国内账号选 `China`，海外账号选 `Global`；手机号和邮箱都可以。
2. 登录成功后，在设备列表里点 `使用这台打印机`。
3. 填 Notion Token 和 Notion 页面 ID。
4. 第一次建议保持 `Dry run = true`，点 `保存并重启同步` 看日志和状态。
5. 确认没问题后改成 `Dry run = false`，之后会每 10 分钟自动同步一次，也可以点 `立即同步` 手动同步。

Docker 会把配置和 Bambu token 保存在本地：

```text
./data/app-config.json
./data/bambu-cloud.json
```

这些文件包含 token，已经在 `.gitignore` 里。

这个 Web 控制台目前没有登录鉴权，建议只在本机、可信局域网或 VPN 内访问，不要直接暴露到公网。

## Docker 镜像和持久化

这个项目的容器启动后只运行 Web 控制台；配置、登录和同步都在页面里完成。镜像本身不包含任何 token，运行时需要把 `/app/data` 映射出来做持久化缓存。

手动构建镜像：

```bash
docker build -t bambu-ams-notion-sync:latest .
```

不用 Compose 时也可以直接运行：

```bash
mkdir -p ./data
docker run -d \
  --name bambu-ams-notion-sync \
  --restart unless-stopped \
  -p 3030:3030 \
  -e ADMIN_HOST=0.0.0.0 \
  -e ADMIN_PORT=3030 \
  -e APP_CONFIG_FILE=/app/data/app-config.json \
  -e BAMBU_CLOUD_TOKEN_FILE=/app/data/bambu-cloud.json \
  -v "$(pwd)/data:/app/data" \
  bambu-ams-notion-sync:latest
```

持久化文件说明：

| 宿主机文件 | 容器内路径 | 说明 |
| --- | --- | --- |
| `./data/app-config.json` | `/app/data/app-config.json` | Web 页面保存的同步配置，例如 Notion 页面 ID、同步周期、dry-run |
| `./data/bambu-cloud.json` | `/app/data/bambu-cloud.json` | Bambu Cloud 登录 token、uid、broker 和设备列表 |

备份这两个文件就能迁移配置。删除 `./data` 或在页面点击 `重置`，下次打开就是首次配置状态。

## 发布到 Docker Hub

仓库内置 GitHub Actions 会自动构建并推送多架构镜像：

- push 到 `main`：发布 `lie5860/bambu-ams-notion-sync:latest` 和 `:main`
- push `v0.1.0` 这种 tag：发布 `:v0.1.0`、`:0.1.0`、`:0.1`
- 也可以在 GitHub Actions 页面手动运行 `Docker Publish`

第一次使用前，需要在 GitHub 仓库里配置两个 Actions secrets：

| Secret | 说明 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 用户名，例如 `lie5860` |
| `DOCKERHUB_TOKEN` | Docker Hub access token，建议不要用账号密码 |

创建版本发布：

```bash
git tag v0.1.0
git push origin v0.1.0
```

用户拉取和运行：

```bash
mkdir -p ./data
docker run -d \
  --name bambu-ams-notion-sync \
  --restart unless-stopped \
  -p 3030:3030 \
  -e ADMIN_HOST=0.0.0.0 \
  -e ADMIN_PORT=3030 \
  -e APP_CONFIG_FILE=/app/data/app-config.json \
  -e BAMBU_CLOUD_TOKEN_FILE=/app/data/bambu-cloud.json \
  -v "$(pwd)/data:/app/data" \
  lie5860/bambu-ams-notion-sync:latest
```

## Notion Token 怎么拿

打开 Notion 的 [My integrations](https://www.notion.so/my-integrations)，创建一个 internal integration，然后复制 `Internal Integration Secret` 填到网页里的 `Notion Token`。

然后打开你的 `3D Print` 页面，把这个 integration 添加到页面的 `Connections`。不加这一步的话，Notion API 看不到你的页面和数据库。

网页里的 `Notion 页面/数据库/Data source ID` 可以填：

- 页面链接里的 32 位页面 ID
- database ID
- data source ID

如果填页面 ID，程序会在这个页面下查找或创建独立的 `AMS 耗材` 子数据库。

## 同步到 Notion 的字段

默认字段固定，不需要手动配置字段名：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `AMS 耗材` | Title | 页面标题，格式是 `材料 · RFID短码`，例如 `PLA Basic · C6A86FCC` |
| `RFID Tag UID` | Rich text | 主键，来自 AMS 的 `tag_uid` |
| `余量%` | Number | AMS 上报的剩余百分比 |
| `剩余克数` | Number | 按余量和料盘重量估算 |
| `材料` | Rich text | 例如 `PLA Basic` |
| `颜色` | Rich text | 十六进制颜色 |
| `料盘重量g` | Number | AMS 上报的 `tray_weight`，默认 1000g |
| `Tray UUID` | Rich text | Bambu 上报的另一个耗材/料盘识别值 |
| `最后同步时间` | Date | 最近一次同步时间 |

每条 `AMS 耗材` 页面会设置一个真实色号生成的小图片 icon，例如：

```text
https://dummyimage.com/64x64/C12E1F/C12E1F.png
```

Notion 的 Relation 选择器通常会显示页面 icon，所以选择关联耗材时能直接看到颜色；标题只保留材料和 RFID 短码，避免重复信息太多。

## Tray UUID 是什么

`tag_uid` 是 RFID 标签 UID，更适合做“这卷耗材”的主键。

`tray_uuid` 是 Bambu 在 AMS 数据里同时上报的另一个识别值，社区 Spoolman 项目常用它来绑定原厂 Bambu 料盘。它不是槽位；槽位是 A0/A1/A2/A3。这里保留 `Tray UUID` 只是为了排查和兼容，主键仍然是 `RFID Tag UID`。

## 常用操作

查看日志：

```bash
docker logs -f bambu-ams-notion-sync
```

停止服务：

```bash
docker compose down
```

手动同步：

```text
打开 http://localhost:3030，点击「立即同步」
```

模拟新用户：

```text
打开 http://localhost:3030，点击「重置」，二次确认输入 RESET
```

这个操作会清空 Web 控制台保存的配置和 Bambu Cloud token，并停止同步服务；不会删除 Notion 里的数据库或页面。

同步周期默认是 `600000` 毫秒，也就是 10 分钟。可以在网页的 `同步周期` 里修改。

## 本地开发

不用 Docker 时：

```bash
npm install
npm start
```

然后打开：

```text
http://localhost:3030
```

旧的命令行同步入口还保留着：

```bash
npm run sync:start
```

## 本地 MQTT 模式

默认推荐 Cloud 模式，因为打印机不在当前局域网时也能同步。

如果你想完全不走云端，可以在网页里把 `同步方式` 改成 `Local MQTT`，并填：

```text
BAMBU_PRINTER_IP
BAMBU_ACCESS_CODE
BAMBU_PRINTER_SERIAL
```

这种模式要求运行服务的机器能访问打印机所在局域网。
