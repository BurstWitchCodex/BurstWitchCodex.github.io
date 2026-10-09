/* data_pretty · data/t/Statistics.js —— 工具生成的数据文件，请勿手改。
 * Lua 配置表 Statistics 的抽取结果：name/accessor/file 是表身份；fields 是字段名顺序；rows 是数据行，每行是按 fields 顺序排列的数组。
 * 读取方：tools/pages_archive_audio.js、tools/pages_archive_media.js（eval 载入 window.DB_TABLES）。
 * 生成者：tools/web_extract.py（跑完执行 node tools/data_pretty.js 恢复排版）
 * 版式由 tools/data_pretty.js 维护（只动空白不动值，可用 --check 复验）。 */
window.DB_TABLES=window.DB_TABLES||{};window.DB_TABLES["Statistics"]={
 "name": "statistics",
 "accessor": "Statistics",
 "fields": ["id","cond_used","desc","cond_desc"],
 "keyIndex": [1,2,3,4],
 "ids": ["10001","10002","10003","10004","10005","10006","10007","10008","10009"],
 "rows": [
  [10001,[[1,100000],[3,100000]],"抽奖(召唤)次数统计","Gashapon:Type"],
  [10002,[[2,100000],[3,300000],[4,30000000]],"召唤魔女统计","CardCharacter:Quality"],
  [10003,[[4,999999999]],"大章类型出战次数统计","DungeonMap:Level_main_type"],
  [10004,[[4,8000000000000]],"大章类型总得分统计","DungeonMap:Level_main_type"],
  [10005,[[4,12000000000]],"大章类型必杀技使用统计","DungeonMap:Level_main_type"],
  [10006,[[4,30000000]],"大章类型擦弹分统计","DungeonMap:Level_main_type"],
  [10007,[[1,300000000],[2,100000000],[3,600000000]],"击杀怪物统计","EnemeyCharacter:Enemey_type"],
  [10008,[[1,50000000000]],"【深夜】击杀怪物统计","EnemeyCharacter:Enemey_type"],
  [10009,[[1,40000],[2,40000]],"解锁图鉴数量","1魔女 2装备"]
 ]
};
