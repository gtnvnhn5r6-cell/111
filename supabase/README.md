# Supabase 接入准备

当前项目：`https://qtollsovdhuazajtpvip.supabase.co`

## 1. 建表

打开 Supabase Dashboard → SQL Editor，执行 [`schema.sql`](./schema.sql)。

这一步需要项目所有者权限。浏览器端使用的 anon key 不能建表，也不应该使用 service_role key。

## 2. 配置登录跳转

Dashboard → Authentication → URL Configuration：

- **Site URL**：`https://gtnvnhn5r6-cell.github.io/111/`
- **Redirect URLs**：加入
  - `https://gtnvnhn5r6-cell.github.io/111/`
  - `http://127.0.0.1:3210/`（本地调试）

项目已开启 Email 登录，前端将使用邮箱 magic link；不需要在网页里保存密码。

## 3. 数据隔离

`chat_conversations` 已启用 RLS，四个策略均只允许 `auth.uid() = user_id` 的读写删。前端只使用 anon key；不要把它替换成 service_role key。

## 4. 已确认的项目状态

- Email 登录：开启
- Anonymous 登录：关闭
- 数据库表：尚未创建
- anon key 可以调用 Auth，但没有 DDL 权限
