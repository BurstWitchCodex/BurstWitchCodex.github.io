/* data_pretty · data/t/MidNightBlessing.js —— 工具生成的数据文件，请勿手改。
 * Lua 配置表 MidNightBlessing 的抽取结果：name/accessor/file 是表身份；fields 是字段名顺序；rows 是数据行，每行是按 fields 顺序排列的数组。
 * 读取方：tools/pages_archive_audio.js、tools/pages_archive_media.js（eval 载入 window.DB_TABLES）。
 * 生成者：tools/web_extract.py（跑完执行 node tools/data_pretty.js 恢复排版）
 * 版式由 tools/data_pretty.js 维护（只动空白不动值，可用 --check 复验）。 */
window.DB_TABLES=window.DB_TABLES||{};window.DB_TABLES["MidNightBlessing"]={
 "name": "midnightblessing",
 "accessor": "MidNightBlessing",
 "fields": ["id","sortID","Name","Name2","Des","Des2","Deskill_id","FreeTime","Price","blesstype","param1","enable"],
 "keyIndex": [1,2,3,4,5,6,7,8,9,10,11,12],
 "ids": ["2000101","2000201","2000301","2000401","2000501"],
 "rows": [
  [2000101,2,10250001,"贪婪",20250001,"击杀额外增加30%战斗时间",2000101,0,[4,1000002,50],1,30,1],
  [2000201,5,10250002,"怠惰",20250002,"使用后完全恢复神火及必杀冷却",2000201,0,[4,1000002,50],2,0,0],
  [2000301,3,10250003,"傲慢",20250003,"必杀技消耗的神火减少10%",2000301,0,[4,1000002,50],3,10,1],
  [2000401,1,10250004,"暴食",20250004,"战斗分数(不含擦弹）额外增加10%",2000401,0,[4,1000002,50],4,10,1],
  [2000501,4,10250005,"愤怒",20250005,"受到致命伤害时，恢复50%生命值",2000501,0,[4,1000002,50],5,50,0]
 ]
};
