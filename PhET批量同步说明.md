# PhET批量同步说明

树子AI的PhET模拟文件不批量提交到GitHub。GitHub只保存实验目录、同步脚本和页面代码。

## 第一批

- 批次名称：`phase1`
- 数量：30个目录项目，下载30个独立HTML文件
- 范围：小学、初中、高中常用物理、数学、化学、生物、地球科学实验
- 语言：简体中文HTML5
- 实测占用：90.00MiB

“波的干涉”同时归入物理和地球科学筛选，但目录和服务器都只保留一份。

## 第二批

- 批次名称：`phase2`
- 数量：30个目录项目
- 范围：优先补充小学、初中、高中的力学、电学、热学、光学、数学、化学和生物实验
- 语言：简体中文HTML5
- 实测占用：70.95MiB

第二批完成后，目录总数为60个，两批合计约160.95MiB。同步脚本默认使用 `all`，
会同时维护第一批和第二批。

## 第三批

- 批次名称：`phase3`
- 数量：40个目录项目
- 范围：只选择小学、初中和高中适用实验，不加入大学专用实验
- 语言：36个简体中文HTML5；4个官方暂未提供中文翻译的低语言依赖小学/初中数学实验
- 实测占用：117.13MiB

第三批完成后，目录总数为100个，三批合计约278.08MiB。英文界面项目已在中文标题中明确标注。

## 第四批

- 批次名称：`phase4`
- 数量：16个目录项目
- 范围：小学、初中、高中及高中拓展，不包含微积分、傅里叶、高等量子和抽样分布等大学内容
- 语言：官方英文HTML5，中文目录名称明确标注“英文界面”
- 实测占用：51.58MiB

第四批完成后，目录总数为116个，四批合计约329.66MiB。

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
node scripts/phet-sync.mjs --batch phase2 --check
```

检查全部批次：

```bash
cd /var/www/shuzi-ai
node scripts/phet-sync.mjs --batch all --check
```

## 更新规则

- 脚本根据官方文件的 `Last-Modified` 判断是否需要更新。
- 新文件先完整下载并验证，再替换旧文件。
- 官方检查失败时保留服务器上的旧版本。
- 状态、文件大小和SHA-256记录在服务器数据目录的 `phet-sync-state.json`。
- 页面不调用AI、不要求登录、不收费、不扣积分。
