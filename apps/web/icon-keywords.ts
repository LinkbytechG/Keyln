// T32. Iconify only understands English search words, so Chinese words are replaced with English ones on this device
// before anything is sent. This is a fixed table, not a translation service: nothing is looked up online, and the Mac
// and Iconify only ever receive the English words that come out of iconKeywords().
//
// One entry per line: the Chinese word, a space, then the English search word(s). Longer Chinese words win over shorter
// ones ("网易云音乐" is one word, not 网易 + 音乐). Several Chinese words may share one English word.
const TABLE = `
主页 home
首页 home
家 home
房子 house
设置 settings
设定 settings
齿轮 gear
文件夹 folder
文件 file
文档 document
搜索 search
查找 search
搜 search
播放 play
暂停 pause
停止 stop
下一首 next
下一个 next
上一首 previous
上一个 previous
快进 forward
快退 rewind
前进 forward
返回 back
音量 volume
静音 mute
耳机 headphones
扬声器 speaker
喇叭 speaker
麦克风 microphone
话筒 microphone
录音 record
录制 record
直播 live
截图 screenshot
截屏 screenshot
相机 camera
照相机 camera
摄像头 webcam
摄像机 videocam
视频 video
音乐 music
歌曲 music
图片 image
照片 photo
相册 gallery
终端 terminal
命令行 terminal
命令 command
代码 code
浏览器 browser
邮件 mail
邮箱 mail
信封 envelope
日历 calendar
时钟 clock
时间 time
闹钟 alarm
锁 lock
解锁 unlock
电源 power
关机 power
开关 toggle
重启 restart
刷新 refresh
同步 sync
下载 download
上传 upload
复制 copy
粘贴 paste
剪切 cut
剪贴板 clipboard
删除 delete
垃圾桶 trash
窗口 window
屏幕 monitor
全屏 fullscreen
显示器 monitor
电脑 computer
笔记本 laptop
键盘 keyboard
鼠标 mouse
打印机 printer
打印 print
电视 tv
手机 smartphone
电话 phone
短信 sms
网络 wifi
无线 wifi
无线网 wifi
蓝牙 bluetooth
电池 battery
亮度 brightness
灯 light
灯泡 bulb
星 star
星星 star
心 heart
爱心 heart
喜欢 heart
收藏 favorite
用户 user
人 person
机器人 robot
人工智能 ai
聊天 chat
消息 message
信息 info
会议 meeting
地图 map
定位 location
指南针 compass
天气 weather
太阳 sun
月亮 moon
夜间 night
雪花 snowflake
云 cloud
云端 cloud
闪电 bolt
火 fire
购物车 cart
购物 shopping
钱 money
银行 bank
支付 payment
二维码 qrcode
扫码 qrcode
条形码 barcode
添加 add
加 plus
减 minus
关闭 close
确认 check
完成 done
取消 cancel
向上 up
向下 down
向左 left
向右 right
菜单 menu
更多 more
警告 warning
错误 error
帮助 help
问题 question
保存 save
编辑 edit
分享 share
链接 link
放大 zoom
缩小 zoom
旋转 rotate
撤销 undo
重做 redo
排序 sort
筛选 filter
列表 list
网格 grid
表格 table
图表 chart
统计 chart
控制 control
工具 tool
扳手 wrench
锤子 hammer
火箭 rocket
数据库 database
服务器 server
安全 security
盾牌 shield
钥匙 key
密码 password
指纹 fingerprint
眼睛 eye
隐藏 hide
显示 show
笔记 note
备忘录 notes
书 book
书签 bookmark
标签 tag
旗帜 flag
铃铛 bell
通知 notification
翻译 translate
计算器 calculator
词典 dictionary
访达 finder
游戏 game
手柄 gamepad
咖啡 coffee
茶 tea
食物 food
餐厅 restaurant
汽车 car
火车 train
飞机 airplane
地球 globe
世界 world
回收 recycle
健康 health
微信 wechat
钉钉 dingtalk
飞书 lark
抖音 tiktok
支付宝 alipay
淘宝 taobao
天猫 tmall
哔哩哔哩 bilibili
b站 bilibili
网易云音乐 netease
网易云 netease
网易 netease
百度 baidu
知乎 zhihu
微博 weibo
小红书 xiaohongshu
美团 meituan
华为 huawei
小米 xiaomi
腾讯 tencent
阿里巴巴 alibaba
阿里 alibaba
豆瓣 douban
爱奇艺 iqiyi
优酷 youku
快手 kuaishou
谷歌 google
谷歌浏览器 chrome
苹果 apple
微软 microsoft
安卓 android
推特 twitter
脸书 facebook
油管 youtube
领英 linkedin
亚马逊 amazon
火狐 firefox
电报 telegram
`;

export const ICON_KEYWORD_PAIRS: readonly (readonly [string, string])[] = TABLE.trim().split("\n").map(line => {
  const cut = line.indexOf(" ");
  return [line.slice(0, cut), line.slice(cut + 1)] as const;
});
const KEYWORDS = new Map(ICON_KEYWORD_PAIRS);
const LONGEST = Math.max(...ICON_KEYWORD_PAIRS.map(([word]) => Array.from(word).length));
/** A few English words that work well, offered when nothing in the search could be understood. */
export const ICON_KEYWORD_EXAMPLES = ["home", "settings", "camera", "music", "github", "wifi"] as const;

export interface IconKeywords {
  /** English words only, ready to send; empty when nothing usable is left. */
  query: string;
  /** The text contained Chinese characters. */
  chinese: boolean;
  /** How many Chinese words were replaced by English ones. */
  converted: number;
}
const HAN = /\p{Script=Han}/u;
/**
 * Turns what the person typed into English search words. Known Chinese words (longest match first) become their English word,
 * unknown Chinese is dropped, and English letters, digits and punctuation are kept as typed. Full-width letters become
 * ordinary ones and accents are removed; anything else outside ASCII is dropped. Repeated words appear once and the
 * result never exceeds 64 characters.
 */
export function iconKeywords(input: string): IconKeywords {
  const chars = Array.from(String(input).normalize("NFKD").replace(/\p{M}/gu, "")), lower = chars.map(char => char.toLowerCase());
  const words: string[] = []; let buffer = "", converted = 0, index = 0;
  const flush = () => { if (buffer) words.push(buffer); buffer = ""; };
  while (index < chars.length) {
    let hit: string | undefined, length = 0;
    for (let size = Math.min(LONGEST, chars.length - index); size > 0 && !hit; size--) { hit = KEYWORDS.get(lower.slice(index, index + size).join("")); length = size; }
    if (hit) { flush(); words.push(hit); converted++; index += length; continue; }
    // Unknown Chinese, and any other character outside printable ASCII, only separates words.
    if (/[\x21-\x7e]/.test(chars[index]!)) buffer += chars[index]; else flush();
    index++;
  }
  flush();
  const query: string[] = [], seen = new Set<string>();
  for (const word of words) {
    if (seen.has(word.toLowerCase())) continue;
    if ([...query, word].join(" ").length > 64) break;
    seen.add(word.toLowerCase()); query.push(word);
  }
  return { query: query.join(" "), chinese: chars.some(char => HAN.test(char)), converted };
}
