# PhET批量同步说明

树子AI的PhET模拟文件不批量提交到GitHub。GitHub只保存实验目录、同步脚本和页面代码。

## 第一批

- 批次名称：`phase1`
- 数量：30个目录项目，下载30个独立HTML文件
- 范围：小学、初中、高中常用物理、数学、化学、生物、地球科学实验
- 语言：简体中文HTML5
- 实测占用：90.00MiB

“波的干涉”同时归入物理和地球科学筛选，但目录和服务器都只保留一份。

## 服务器存储

推荐持久目录：

```text
/var/www/shuzi-ai-data/phet
```

构建完成后，将前端目录：

```text
/var/www/shuzi-ai/dist/simulations/phet
```

链接到持久目录。这样重新执行Vite构建时不会复制或删除大型模拟文件。

## 首次同步

```bash
cd /var/www/shuzi-ai
mkdir -p /var/www/shuzi-ai-data/phet
npm run phet:deploy
```

每次执行 `npm run build` 后都要再次执行 `npm run phet:deploy`。Vite 会重建 `dist`，
同步命令会恢复静态链接；已有且未更新的实验不会重复下载。

完整服务器更新命令：

```bash
cd /var/www/shuzi-ai && git pull origin main && npm install && npm run build && mkdir -p /var/www/shuzi-ai-data/phet && npm run phet:deploy && systemctl restart shuzi-ai-api && systemctl reload nginx && systemctl status shuzi-ai-api --no-pager
```

## 检查体积但不保存

```bash
cd /var/www/shuzi-ai
node scripts/phet-sync.mjs --batch phase1 --check
```

## 更新规则

- 脚本根据官方文件的 `Last-Modified` 判断是否需要更新。
- 新文件先完整下载并验证，再替换旧文件。
- 官方检查失败时保留服务器上的旧版本。
- 状态、文件大小和SHA-256记录在服务器数据目录的 `phet-sync-state.json`。
- 页面不调用AI、不要求登录、不收费、不扣积分。
