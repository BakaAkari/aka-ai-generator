export const PLUGIN_NAME = 'aka-ai-generator'
export const CHATLUNA_BRIDGE_PLATFORM_NAME = 'aka-ai-generator-tools'
export const STYLE_TRANSFER_PROMPT = '执行风格转换任务。收到两张图像：IMAGE_1是内容，IMAGE_2是风格。保留IMAGE_1的内容和结构，应用IMAGE_2的艺术风格，输出为1024x1024分辨率。内容锁定：严格保留IMAGE_1中的主体身份、姿势、动作、表情、服装款式、构图布局和背景元素，严禁改变IMAGE_1的几何结构和轮廓，不要引入IMAGE_2中的任何物体、人物、动作或形状。风格应用：分析IMAGE_2的视觉风格（艺术流派、色彩调性、笔触纹理、光影氛围、材质质感），将风格特征应用到IMAGE_1的内容上，让IMAGE_1看起来像是用IMAGE_2的画法重新绘制的。尺寸与填充：最终图像必须严格为1024x1024像素的正方形。如果IMAGE_1的原始比例不是正方形，保持IMAGE_1内容完整且不变形地放置在画面中心，对于周围多出的空白区域，根据IMAGE_1的背景内容和上下文逻辑，使用IMAGE_2的风格生成合理、连贯的背景延伸元素进行填充，确保画面完整自然，无明显接缝或黑边。'
export const COMMAND_TIMEOUT_SECONDS = 300

export const COMMANDS = {
  IMG_TO_IMG: '图生图',
  TXT_TO_IMG: '文生图',
  COMPOSE_IMAGE: '合成图',
  STYLE_TRANSFER: '风格迁移',
  CHANGE_POSE: '改姿势',
  OPTIMIZE_DESIGN: '修改设计',
  PIXELATE: '变像素',
  QUERY_QUOTA: '图像额度',
  RECHARGE: '图像充值',
  RECHARGE_ALL: '活动充值',
  RECHARGE_HISTORY: '图像充值记录',
  IMAGE_COMMANDS: '图像指令',
  IMAGE_PARAMS: '参数指令',
  VIDEO_COMMANDS: '视频指令',
  SINGLE_IMG_VIDEO: '单图生视频',
  MULTI_IMG_VIDEO: '多图生视频',
  QUERY_VIDEO: '查询视频',
} as const
