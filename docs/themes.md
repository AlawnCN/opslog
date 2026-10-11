# 界面主题

主应用顶栏、Reader 标题栏（Web Reader 右上角）提供主题选择，立即生效、自动保存。默认 `cyberpunk` 保留原有外观。新增样式遵循 StyleKit 对应规范：

主题选择复用应用内 `AppSelect`，弹出列表跟随当前主题，不使用操作系统原生菜单。支持方向键、Home/End、Enter/空格选择、Esc/Tab 关闭以及点击外部关闭；选中项显示勾选标记。

组合控件只保留一层材质：主题图标、文字和箭头属于同一颗可点击按钮；环境选择与配置、AI 分析与设置由外容器统一承载背景、圆角、阴影和焦点环，内部段使用平面背景及分隔线，不单独抬升或缩放。

AI 报告的“导出 / MD / HTML”也采用统一的分段边界：内部按钮无独立圆角、外阴影或位移，选中格式使用内侧下划线；键盘焦点在当前段内绘制。下拉菜单、环境/AI 列表、表格、Trace、日志结构树、标记轨道、Reader 标题栏和搜索框等紧凑或滚动区域固定按钮几何边界，禁用会被裁切的外阴影和缩放，保留颜色反馈及内侧焦点环。独立、有留白的操作按钮继续使用主题材质效果，不移除弹窗和列表必要的滚动裁切。

- [Neumorphism](https://www.stylekit.top/styles/neumorphism)：灰白基底、双向柔和阴影、内凹输入框、紫色强调。
- [Glassmorphism](https://www.stylekit.top/styles/glassmorphism)：深蓝光场、中性透明玻璃、香槟色强调、方向性高光。
- [Stripe Style](https://www.stylekit.top/styles/stripe-style)：浅色网格、白色卡片、紫色主按钮、分层阴影。
- [Fluent Design](https://www.stylekit.top/styles/fluent-design)：中性浅色、蓝色强调、选择性 Acrylic 材质与短促反馈。
- [Soft UI](https://www.stylekit.top/styles/soft-ui)：柔和界面，浅色圆润卡片、靛蓝强调与轻柔彩色阴影。
- [Natural Organic](https://www.stylekit.top/styles/natural-organic)：自然有机，奶油暖色、大地色调、衬线标题和有机圆角。
- [Modern Gradient](https://www.stylekit.top/styles/modern-gradient)：现代渐变，深色光场、紫红渐变和玻璃层次。
- [Dark Mode](https://www.stylekit.top/styles/dark-mode)：暗黑模式，低亮度分层、蓝色高光与克制反馈。
- [Claymorphism](https://www.stylekit.top/styles/claymorphism)：粘土拟态，糖果色、柔软立体阴影与弹性按压。
- [Notion Style](https://www.stylekit.top/styles/notion-style)：Notion 风格，米白文档、小圆角和极简颜色反馈。
- [Apple Style](https://www.stylekit.top/styles/apple-style)：Apple 风格，精致留白、系统字体、简洁蓝白与细腻阴影。
- [Shoujo Manga](https://www.stylekit.top/styles/shoujo-manga)：少女漫画，樱花粉、珍珠白、淡紫网点、花形标题装饰及柔和粉色阴影。文字和语义色加深以保障对比度，日志正文保留等宽布局；紧凑控件不做扩张动画。

- [Cyber Anime](https://www.stylekit.top/styles/cyber-anime)：赛博动漫，深色基底、紫色多层霓虹、青绿色 HUD 角框、六边形网格和静态全息扫描纹理。装饰限于面板背景，不裁切内容；紧凑控件继续使用防越界规则，日志区保持平面可读。

共 14 种主题，每项保留英文名称并增加中文风格描述；较长菜单可滚动，键盘切换时当前选项自动进入可视范围。

Neumorphism 使用 `#e0e5ec` 基底、左上光源双阴影、内凹输入框、12/16px 圆角和 `#6d5dfc` 强调色。日志正文保持平面布局，使用加深的语义颜色保障浅色下可读性；支持键盘焦点和减少动态效果偏好。主题层独立于原样式，不修改查询、环境或连接参数。

偏好键为 `opslog.appearance.theme.v1`。Web 保存在当前浏览器、当前站点的 localStorage，并在同源标签页同步；桌面端同时保存在 OpsLog 共享偏好目录的 `appearance-theme.txt`，主应用和 Reader 下次启动均可恢复。无效值回退至 Cyberpunk；浏览器禁用存储时仍可临时切换。

桌面偏好写入串行执行，快速连续切换不会因异步完成顺序恢复成旧主题；浏览器存储写入失败不会阻断原生保存。启动恢复先等待待写入偏好，再读取共享设置；主应用和 Reader 均在渲染前应用恢复的主题。

日志阅读页和 AI 分析报告的 HTML 导出会快照导出时的主题，将材质变量和离线组件样式直接内嵌到文件中；接收者无需联网或安装应用。日志高亮、结构化预览、工具栏及报告正文均使用对应主题，Cyberpunk 保留原有外观。主题在日志压缩前捕获，压缩过程中切换主题不会使导出混用两套样式；此前导出的 HTML 需重新导出才会更新。

界面使用系统无衬线字体（Fluent 优先 Segoe UI），日志和格式化正文保持等宽字体。Logo 使用主题颜色，按钮按压使用独立 `translate` / `scale`，不覆盖定位所需的 `transform`；树节点、密码切换、窗口按钮不做悬停位移。统一处理焦点、禁用、减少动画和不支持背景模糊时的降级。

`theme-palettes.css` 与 `theme-palettes-extra.css` 定义材质变量及风格特例，`theme-components.css` 定义组件状态，`themes.css` 负责布局接入。原样式中的固定颜色使用保留原值的 fallback；Cyberpunk 不定义覆盖变量。新增主题需同时扩展 `theme.ts` 列表及独立 CSS。

自动化覆盖全部 14 种主题切换、恢复、同步、中文描述、存储失败、重复初始化、原生写入排序和模拟冷启动，以及正文/次要文字/语义颜色在基础面板和编辑器背景上的 WCAG AA 对比度、定位与动画样式约束。这些是代码层验证，不等同于浏览器或 Windows/macOS 桌面的视觉验收。
