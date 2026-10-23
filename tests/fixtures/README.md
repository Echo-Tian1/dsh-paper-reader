# 测试夹具

完整测试需要一个真实的论文 PDF 作为夹具（默认是 arXiv:1706.03762v7《Attention Is All You Need》，15 页、双栏/单栏混排、含公式与图表引用）。

**它不随仓库分发**（版权原因）。要跑完整测试：

1. 从 <https://arxiv.org/abs/1706.03762> 下载 PDF；
2. 放到本目录并命名 `1706.03762v7.pdf`，或者
3. 用环境变量指定任意论文 PDF：`PR_FIXTURE=/path/to/paper.pdf node --test`

没有夹具时，依赖真实论文的用例会自动 skip，其余用例照常通过。
