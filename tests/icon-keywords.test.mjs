import test from 'node:test';
import assert from 'node:assert/strict';
import {ICON_KEYWORD_EXAMPLES,ICON_KEYWORD_PAIRS,iconKeywords} from '../dist/apps/web/icon-keywords.js';
import {iconQuery} from '../dist/packages/contracts/index.js';

// T32: Chinese words become English words on the page, with a fixed table. No network is involved anywhere in this file.
const words=text=>iconKeywords(text).query;

test('the keyword table is unique, English on one side and covers the words the design asked for',()=>{
  const keys=ICON_KEYWORD_PAIRS.map(([word])=>word),table=new Map(ICON_KEYWORD_PAIRS);
  assert.equal(new Set(keys).size,keys.length,'no Chinese word is listed twice');assert.ok(keys.length>=190&&keys.length<=260,`${keys.length} entries`);
  for(const [word,english] of ICON_KEYWORD_PAIRS){
    assert.match(word,/^[\p{Script=Han}a-z]+$/u,word);assert.match(word,/\p{Script=Han}/u,word);
    assert.match(english,/^[a-z0-9]+(?: [a-z0-9]+)*$/,`${word} -> ${english}`);assert.equal(iconQuery(english),english,`${word} is a valid search word`);
  }
  const asked={主页:'home',设置:'settings',文件夹:'folder',文件:'file',搜索:'search',播放:'play',暂停:'pause',停止:'stop',下一首:'next',上一首:'previous',音量:'volume',静音:'mute',截图:'screenshot',相机:'camera',麦克风:'microphone',
    终端:'terminal',代码:'code',浏览器:'browser',邮件:'mail',日历:'calendar',时钟:'clock',锁:'lock',电源:'power',重启:'restart',刷新:'refresh',下载:'download',上传:'upload',复制:'copy',粘贴:'paste',删除:'delete',窗口:'window',
    屏幕:'monitor',显示器:'monitor',键盘:'keyboard',鼠标:'mouse',网络:'wifi',蓝牙:'bluetooth',电池:'battery',亮度:'brightness',灯:'light',星:'star',心:'heart',用户:'user',聊天:'chat',消息:'message',电话:'phone',视频:'video',音乐:'music',
    图片:'image',地图:'map',天气:'weather',购物车:'cart',微信:'wechat',钉钉:'dingtalk',飞书:'lark',抖音:'tiktok',支付宝:'alipay',淘宝:'taobao',哔哩哔哩:'bilibili',b站:'bilibili',网易云音乐:'netease',百度:'baidu',知乎:'zhihu',微博:'weibo'};
  for(const [word,english] of Object.entries(asked))assert.equal(table.get(word),english,word);
  assert.ok(ICON_KEYWORD_EXAMPLES.length>=4&&ICON_KEYWORD_EXAMPLES.length<=6);for(const example of ICON_KEYWORD_EXAMPLES)assert.equal(iconQuery(example),example);
});

test('Chinese words are replaced longest first, unknown Chinese is dropped and English is kept as typed',()=>{
  assert.deepEqual(iconKeywords('主页'),{query:'home',chinese:true,converted:1});
  assert.equal(words('网易云音乐'),'netease','the longest known word wins over 网易 + 音乐');assert.equal(words('网易'),'netease');assert.equal(words('音乐'),'music');assert.equal(words('网易 音乐'),'netease music');
  assert.equal(words('下一首'),'next');assert.equal(words('无线网'),'wifi');assert.equal(words('谷歌浏览器'),'chrome');assert.equal(words('谷歌 浏览器'),'google browser');
  // Mixed input: both languages together, in the order typed.
  assert.deepEqual(iconKeywords('主页 camera'),{query:'home camera',chinese:true,converted:1});assert.equal(words('camera 主页'),'camera home');assert.equal(words('主页相机'),'home camera');
  assert.equal(words('github设置'),'github settings');assert.equal(words('QQ音乐'),'QQ music');assert.equal(words('QQ'),'QQ');assert.equal(words('B站'),'bilibili');assert.equal(words('b站 logo'),'bilibili logo');
  assert.equal(words('wifi 无线 3d'),'wifi 3d','repeated words appear once');assert.equal(words('主页 家 Home'),'home');
  // Unknown Chinese is thrown away.
  assert.deepEqual(iconKeywords('龘'),{query:'',chinese:true,converted:0});assert.deepEqual(iconKeywords('龘龘 齉'),{query:'',chinese:true,converted:0});
  assert.equal(words('主页龘'),'home');assert.equal(words('龘主页龘相机龘'),'home camera');
  assert.deepEqual(iconKeywords('龘 abc'),{query:'abc',chinese:true,converted:0},'English words next to unknown Chinese are still searched');
  // Plain English is passed on unchanged.
  assert.deepEqual(iconKeywords('home'),{query:'home',chinese:false,converted:0});assert.equal(words('  Home   Page '),'Home Page');assert.equal(words('c++'),'c++');assert.equal(words('arrow-circle-down'),'arrow-circle-down');assert.equal(words('GitHub'),'GitHub');
  assert.deepEqual(iconKeywords(''),{query:'',chinese:false,converted:0});assert.deepEqual(iconKeywords('   '),{query:'',chinese:false,converted:0});
  // Full-width letters and accents become plain ASCII; other scripts are not English and are dropped.
  assert.equal(words('ＱＱ'),'QQ');assert.equal(words('ｈｏｍｅ'),'home');assert.equal(words('café'),'cafe');assert.equal(words('　主页　'),'home');assert.deepEqual(iconKeywords('привет'),{query:'',chinese:false,converted:0});assert.equal(words('こんにちは home'),'home');
  assert.equal(words('主页\t相机\n'),'home camera');assert.equal(words('主\u0000页'),'','a control character splits a word');
});

test('whatever comes out is English, at most 64 characters and accepted by the Host\'s own search-word check',()=>{
  const inputs=['主页','网易云音乐 QQ音乐 B站','龘','abc 主页 龘 def','ＱＱ　音乐','café 咖啡','a'.repeat(64),['主页','设置','文件夹','搜索','播放','暂停','停止','下一首','上一首','音量','静音','截图'].join(' '),'x'.repeat(60)+' 主页 相机','x'.repeat(70)];
  for(const input of inputs){
    const {query}=iconKeywords(input);assert.match(query,/^[\x20-\x7e]*$/,input);assert.ok(query.length<=64,input);assert.doesNotMatch(query,/ {2}|^ | $/,input);
    if(query.length>=2)assert.equal(iconQuery(query),query,input);
  }
  assert.equal(words(['主页','设置','文件夹','搜索','播放','暂停','停止','下一首','上一首','音量','静音','截图'].join(' ')),'home settings folder search play pause stop next previous volume','words that would pass 64 characters are left out');
  assert.equal(words('x'.repeat(59)+' 主页 相机'),'x'.repeat(59)+' home','a word that would not fit is left out, not cut');assert.equal(words('x'.repeat(60)+' 主页'),'x'.repeat(60));
  assert.equal(words('a'.repeat(70)),'','a single word longer than the limit is dropped');
});
