# 参考来源与方法说明

「评书」插件的手册不是古籍原文，也不是对某位评书演员文本的复制，而是按评书通行术语、叙事规律与降低阅读门槛的写作原则整理的原创工作手册。

## 检索到的公开资料

- [评书_百度百科](https://wapbaike.baidu.com/item/%E8%AF%84%E4%B9%A6/1290657)
- [说书技巧_百度百科](https://wapbaike.baidu.com/item/%E8%AF%B4%E4%B9%A6%E6%8A%80%E5%B7%A7/1664938)
- [评书有哪些叙事技巧和模式? - 知乎](https://www.zhihu.com/question/21027329/answer/14904340631)
- [袁阔成做客清华名家谈文艺畅谈评书艺术 - 清华大学](https://www.tsinghua.edu.cn/info/1181/54602.htm)
- [Pingshu Master Lian Liru - china.org.cn](http://www.china.org.cn/english/NM-e/101406.htm)
- [Internet podcast brings new life to ancient legend - China Daily](http://www.chinadaily.com.cn/culture/2016-02/01/content_23333501.htm)
- [评书概说 - QQ阅读](https://xiaoshuo.qq.com/read/1000610470/4)

## TTS

- [OpenMOSS/MOSS-TTSD](https://github.com/OpenMOSS/MOSS-TTSD)（Apache 2.0）：长篇对话语音合成；插件通过其官方 SGLang `/generate` 接口接入，不打包模型。
- [火山引擎豆包语音：单向流式语音合成 HTTP](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)：插件直接调用 `/api/v3/tts/unidirectional`，使用 `X-Api-Key`、`X-Api-Resource-Id`、`X-Api-Request-Id`，按行解析 Chunked JSON 音频块。
- [SiliconFlow：创建文本转语音请求](https://api-docs.siliconflow.cn/docs/api/audio-speech-post)：托管 `fnlp/MOSS-TTSD-v0.5`，OpenAI 风格 `/v1/audio/speech`，返回 MP3；插件支持 `[S1]/[S2]` 对话标签和单 voice 配置。

## 术语与结构

手册使用的评书术语包括：梁子、坨子、扣子/书扣、书胆、书筋、回目、定场诗、垫话、书接上文、开脸儿、摆砌末、赋赞、贯口、垛句、倒插笔、花开两朵各表一枝、且听下回分解。

这些是评书行内的通用说法，不同流派、不同演员的用法可能略有差异；插件按“能让 AI 写出可听、可懂、可存的文案”来使用，不追求流派考据。

## 降低阅读门槛

手册里的“一句话定义 + 现代类比 + 记忆钩子”“先给路标再走路”“解释嵌在故事里”“拒绝翻译腔”等规则，参考了通用平实语言（plain language）与口语叙事的常见做法，并针对中文听书场景做了调整。

## 说明

当前开发环境对多数外部站点的正文抓取受限，以上链接主要用于来源标注；手册内容为原创综合，不照搬任何受版权保护的评书文本。书的内容版权归用户与原权利人所有，插件只做本地摘要、讲解与演绎。
