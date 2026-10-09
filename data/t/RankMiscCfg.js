/* data_pretty · data/t/RankMiscCfg.js —— 工具生成的数据文件，请勿手改。
 * Lua 配置表 RankMiscCfg 的抽取结果：name/accessor/file 是表身份；fields 是字段名顺序；rows 是数据行，每行是按 fields 顺序排列的数组。
 * 读取方：tools/pages_archive_audio.js、tools/pages_archive_media.js（eval 载入 window.DB_TABLES）。
 * 生成者：tools/web_extract.py（跑完执行 node tools/data_pretty.js 恢复排版）
 * 版式由 tools/data_pretty.js 维护（只动空白不动值，可用 --check 复验）。 */
window.DB_TABLES=window.DB_TABLES||{};window.DB_TABLES["RankMiscCfg"]={
 "name": "rankmisccfg",
 "accessor": "RankMiscCfg",
 "fields": [
  "id",
  "RankTypeStr",
  "DivDays",
  "PlayerMax",
  "RobotMax",
  "TopRobotScoreRange",
  "NormalRobotScoreRange",
  "SeasonSettleWeekDay",
  "SeasonSettleHour",
  "DaySettleHour"
 ],
 "keyIndex": [1,2,3,4,5,6,7,8,9,10],
 "ids": ["3","4","5"],
 "rows": [
  [3,"深夜永久=3",30,5000,2000,[100000,200000],[200,99999],1,5,21],
  [4,"世界BOSS=4",7,5000,0,[0,0],[0,0],0,0,5],
  [5,"深夜永久=3",30,5000,2000,[100000,200000],[200,99999],1,5,21]
 ]
};
