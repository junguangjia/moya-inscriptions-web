# 资产清单

除用户明确指定的三个底部导航 PNG 字标外，资产均为 SVG；不含字体、base64、外链或运行时本地绝对路径。正式资产位于
`packages/ui/src/assets/`，演示内容位于 `docs/design-system/assets/demo/`。

## 品牌

| 仓库文件              | 用途                                                       | 来源                                                      | 路径修改                                                     | 颜色修改                                       | 授权说明                                 |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------- |
| `brand/yoyi-logo.svg` | 认证、桌面品牌区、LoadingScreen、管理端和当前组件目录/原型 | Owner 在 #167 视觉验收中指定的 2026-09-08 新 ArtVenn 标记 | 根据提供的图形制作透明矢量剪影；保留左侧开口圆及右侧镜片孔洞 | 组件沿用 alpha mask/currentColor，适配明暗主题 | Owner 明确要求所有当前 logo 替换为此标记 |

SVG viewBox 为 `297 411 658 426`，共享展示比例为
`658 / 426`。源图的白色画布不属于 logo，不进入 alpha
mask。私有源图由 Owner 保留；仓库 SVG SHA-256 为
`a611503f5256a806cf11d66efcc0b34817b7bb5017a9743152337cadac0bb5d4`。

此新授权替代旧字形 logo 的路径/哈希保留要求。历史截图和审计记录保留原事实。

## 纸张纹理

| 文件                     | 用途               | 原创 | 参数                        |
| ------------------------ | ------------------ | ---: | --------------------------- |
| `paper-subtle.svg`       | 克制浅色纸张       |   是 | 384×512 tile，opacity 0.048 |
| `paper-visible.svg`      | 移动主界面浅色纸张 |   是 | 384×512 tile，opacity 0.068 |
| `paper-dark-subtle.svg`  | 克制深色纸张       |   是 | 384×512 tile，opacity 0.045 |
| `paper-dark-visible.svg` | 移动主界面深色纸张 |   是 | 384×512 tile，opacity 0.065 |

参考 Owner 提供并私下保留的原始历史图像之色温、纵向纤维和低频斑驳；纤维噪声方向为
`0.16 0.008`，未复制或嵌入任何像素。

## 图标

`home.svg`、`inscriptions.svg`、`calligraphy.svg`、`search.svg`、`back.svg`、
`menu.svg`、`close.svg`、`filter.svg`、`category.svg`、`location.svg`、
`nearby.svg`、`image.svg`、`loading.svg`、`error.svg`、`empty.svg`、
`previous.svg`、`next.svg` 均逐字节恢复为首个 T02 提交 `616c9a5` 的 24×24
currentColor 圆角线性图标。`settings.svg`
是同一线宽和端点规范下新增的原创齿轮图标。 `theme.svg` 仅为 `ThemeCycleButton`
的兼容资产，不再用于移动主预览。Owner 提供并私下保留的原始界面参考图仅用于核对原版图标和底栏组合，未复制或嵌入其中像素。

## 固定字标

底部三个固定字标直接使用用户提供 PNG 的字形像素。处理仅包括以 alpha≥32 确定边界、清除低透明度背景残影、等比缩放并居中到 264×120 透明画布；未重绘、矢量化、改色或改变内部纹理：

- `nav-home.png`：Owner 提供的原始字标资产；私有源文件由 Owner 保留。
- `nav-inscriptions.png`：Owner 提供的原始字标资产；私有源文件由 Owner 保留。
- `nav-calligraphy.png`：Owner 提供的原始字标资产；私有源文件由 Owner 保留。

这三个文件是本设计系统唯一允许的位图例外。顶部“发现、附近”和其他界面文字均使用系统字体。

## 演示图

`docs/design-system/assets/demo/` 中的
`discovery-stone.svg`、`inscription-rubbing.svg`、`calligraphy-sheet.svg`、
`cliff-gate.svg`、`valley-wall.svg`、`stone-detail.svg`、`rubbing-fragment.svg`、
`ink-album.svg`、`stele-shadow.svg`
是原创抽象占位图，仅用于文档、组件目录和非生产原型，不代表真实藏品。它们不随
`@moya/ui` 发布，也不通过公共 UI API 导出。
