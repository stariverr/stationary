## Gemini Embeddings 2

模态 规范和限制
文本 最多支持 8,192 个 token。
Image 每个请求最多 6 张图片。支持的格式：PNG、JPEG。
音频 时长上限为 180 秒。支持的格式：MP3、WAV。
视频 时长上限为 120 秒。支持的格式：MP4、MOV。支持的编解码器：H264、H265、AV1、VP9。
系统最多处理每个视频 32 帧：短视频（≤32 秒）的抽样率为 1 fps，而较长的视频则会均匀抽样为 32 帧。视频文件中的音轨未经过处理。
文档 (PDF) 每个请求最多包含 1 个文件，最多 6 页。

属性 说明
模型代码
Gemini API

gemini-embedding-2

支持的数据类型
输入

文本、图片、视频、音频、PDF

输出

文本嵌入

令牌限制[*]
输入 token 限制

8192

输出维度大小

灵活，支持：128 - 3072，推荐：768、1536、3072

版本
如需了解详情，请参阅模型版本模式。
稳定：gemini-embedding-2
最新更新 2026 年 4 月

检索用例（非对称格式）

在非对称使用情形下，请向查询添加任务前缀，并为要嵌入和检索的内容应用文档结构。

使用场景 查询结构 文档结构
搜索查询 task: search result | query: {content} title: {title} | text: {content}
如果没有标题，则使用 title: none。
问答 task: question answering | query: {content} title: {title} | text: {content}
事实核查 task: fact checking | query: {content} title: {title} | text: {content}
代码检索 task: code retrieval | query: {content} title: {title} | text: {content}
使用示例

Python

# Generate embedding for a task's query. Use your correct task here:

def prepare_query(query): # return f"task: question answering | query: {query}" # return f"task: fact checking | query: {query}" # return f"task: code retrieval | query: {query}"
return f"task: search result | query: {query}"

# Generate embedding for document of an asymmetric retrieval task:

def prepare_document(content, title=None):
if title is None:
title = "none"
return f"title: {title} | text: {content}"
单输入源用例（对称格式）

在对称用例中，对于同一任务，请对查询和文档使用相同的格式。

使用场景 输入结构
分类 task: classification | query: {content}
聚簇 task: clustering | query: {content}
语义相似度 task: sentence similarity | query: {content}
请勿将此方法用于搜索或检索。它适用于语义文本相似度。
使用示例

Python

# Generate embedding for query & document of your task.

def prepare_query_and_document(content): # return f'task: clustering | query: {content}' # return f'task: sentence similarity | query: {content}'
return f'task: classification | query: {content}'
请务必持续使用该任务。例如，如果文档嵌入了 f'task: classification | query: {content}'，则查询也应按照此任务格式嵌入。

# Qwen 3 VL Embeddings

Model Specifications
Model Size Layers Sequence Length Embedding Dimension Quantization Support MRL Support Instruction Aware
Qwen3-VL-Embedding-2B 2B 28 32K 2048 ✅ ✅ ✅
Qwen3-VL-Embedding-8B 8B 36 32K 4096 ✅ ✅ ✅
Qwen3-VL-Reranker-2B 2B 28 32K - - - ✅
Qwen3-VL-Reranker-8B 8B 36 32K - - - ✅

请求体（Request Body）
model string（必选）

模型名称。设置为模型概览中的模型名称。

input object （必选）

输入内容。

属性

contents array（必选）

待处理的内容列表。每个元素是一个字典或者字符串，用于指定内容的类型和值。格式为{"模态类型": "输入字符串或图像、视频url"}。支持text, image, video和multi_images四种模态类型。

qwen3-vl-embedding 同时支持融合向量和独立向量生成。在多模态独立向量的基础上增加 bool 类型字段 enable_fusion，当 enable_fusion=true 时返回融合向量。qwen2.5-vl-embedding 仅支持融合向量，不支持独立向量。tongyi-embedding-vision-plus-2026-03-06 和 tongyi-embedding-vision-flash-2026-03-06 同时支持独立向量和融合向量，通过将 text、image、video 放在同一个 content 对象中生成融合向量（不使用 enable_fusion 参数）。
文本：key为text。value为字符串形式。也可不通过dict直接传入字符串。

图片：key为image。value可以是公开可访问的URL，或Base64编码的Data URI。Base64格式为 data:image/{format};base64,{data}，其中 {format} 是图片格式（如 jpeg, png），{data} 是Base64编码字符串。

多图片：仅tongyi-embedding-vision-plus、tongyi-embedding-vision-flash、tongyi-embedding-vision-plus-2026-03-06与tongyi-embedding-vision-flash-2026-03-06模型支持此类型。key为multi_images，value是多图序列列表，每条为一个图片，格式要求如上方所示。

视频：key为video，value必须是公开可访问的URL。

parameters object （可选）

向量处理参数。HTTP调用需包装在parameters对象中，SDK调用可直接使用以下参数。

属性

output_type string （可选）

用户指定输出向量表示格式，目前仅支持dense。

dimension integer （可选）

用于用户指定输出向量维度。不同模型支持的值不同：

qwen3-vl-embedding 支持 2560、2048、1536、1024、768、512、256，默认值为 2560；

qwen2.5-vl-embedding 支持 2048、1024、768、512，默认值为 1024；

tongyi-embedding-vision-plus 不支持此参数，固定返回 1152 维向量。

tongyi-embedding-vision-flash 不支持此参数，固定返回 768 维向量。

tongyi-embedding-vision-plus-2026-03-06 支持 64、128、256、512、1024、1152，默认值为 1152；

tongyi-embedding-vision-flash-2026-03-06 支持 64、128、256、512、768，默认值为 768；

multimodal-embedding-v1 不支持此参数，固定返回 1024 维向量。

fps float （可选）

控制视频的帧数，比例越小，实际抽取的帧数越少，范围为 [0,1]。默认值为1.0。

instruct string （可选）

添加自定义任务说明，可用于指导模型理解查询意图。建议使用英文撰写，通常可带来约 1%–5% 的效果提升。

enable_fusion bool （可选）

是否生成融合向量。仅 qwen3-vl-embedding 模型支持该参数。设置为 true 时，将 contents 中的所有多模态内容融合为 1 个向量；默认为 false，各模态独立生成向量。融合向量支持文本+图片、文本+视频、多图+文本（传入多个 image 条目）、图片+视频+文本等组合，适用于需要综合理解多模态内容的检索场景。

tongyi-embedding-vision-plus-2026-03-06 和 tongyi-embedding-vision-flash-2026-03-06 不使用该参数，而是通过将 text、image、video 放在同一个 content 对象中来生成融合向量。
res_level integer （可选）

指定输入分辨率档位，支持设置 0/1/2/3 四档，对应的单图 token 分别是 127/402/578/1026，默认值为 1（402 token）。仅 tongyi-embedding-vision-plus-2026-03-06 和 tongyi-embedding-vision-flash-2026-03-06 模型支持该参数。对于 IPC/自驾/视觉文字等图像分辨率敏感的场景，高分辨率（res_level=3）可提升 5%-10% 效果。

max_video_frames integer （可选）

控制视频的最大采样帧数上限，最大不超过 64，默认值为 8。仅 tongyi-embedding-vision-plus-2026-03-06 和 tongyi-embedding-vision-flash-2026-03-06 模型支持该参数。
