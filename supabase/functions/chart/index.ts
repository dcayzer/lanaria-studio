// Quantize an input image into a cross-stitch / needlepoint chart using a
// real thread palette. Returns palette, symbol map, usage counts, sections
// and a run-length encoded pixel grid.
//
// Body: { imageUrl, brand: "appletons"|"dmc", mesh, finishedWidthInches,
//   finishedHeightInches, maxColours, shading: "none"|"light"|"medium"|"heavy" }

import { decode, Image } from "https://deno.land/x/imagescript@1.2.17/mod.ts";
import { repairJunctionErosion } from "./junction-repair.ts";
import { runStructuralPass, identifyOutermostRegion } from "./structural-model.ts";
import { holeFill, gapBridge } from "./cleanup-passes.ts";
import { mergeNearDuplicatePaletteEntries, cullTinyEntries } from "./palette-merge.ts";
import { ciede2000 } from "./chartability.ts";
import {
  averageColour,
  channelWithLargestRange,
  medianCut,
  isPlainWhite,
  buildClusterColours,
  medianDenoise,
  computeFlatRegionMask,
  estimateNaturalColourCount,
  findSalientColourIslands,
} from "./palette-derivation.ts";
import { shapeMask } from "./shape-outline.ts";
import { CHART_DIAG, resetChartDiag } from "./diag.ts";
import {
  depthsForMask,
  shapedFrameCells,
  accentsAroundShape,
  stampsAroundShape,
} from "./shape-aware-border.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// DMC Coton Perle #5 — VERBATIM COPY of DMC_PALETTE in src/data/threadPalettes.ts,
// which is the canonical app-wide colour data. The engine previously kept its own
// small divergent subset: same DMC codes carried hexes up to 29.8 Lab units from
// the canonical values, so a chart was computed against one colour while the
// Thread Shopping List told the customer to buy a visibly different thread. It
// also had no yellow-green family at all (its only greens were blue-green jades
// at hue 130-168), so olive source colours at hue 112-127 matched to GOLD as the
// nearest available family and green vanished from DMC charts entirely.
// THESE TWO ARRAYS MUST BE KEPT IDENTICAL. Edge functions cannot import from
// src/, which is why this copy exists; it is not an independent dataset.
export const DMC_PALETTE: any = [
  {id:"208",n:"Lavender Very Dark",f:"Lavender",hex:"#835B8B"},
  {id:"209",n:"Lavender Dark",f:"Lavender",hex:"#A37BA7"},
  {id:"210",n:"Lavender Medium",f:"Lavender",hex:"#C39FC3"},
  {id:"211",n:"Lavender Light",f:"Lavender",hex:"#E3CBE3"},
  {id:"221",n:"Shell Pink Vy Dk",f:"Shell Pink",hex:"#883E43"},
  {id:"223",n:"Shell Pink Light",f:"Shell Pink",hex:"#CC847C"},
  {id:"224",n:"Shell Pink Very Light",f:"Shell Pink",hex:"#EBB7AF"},
  {id:"225",n:"Shell Pink Ult Vy Lt",f:"Shell Pink",hex:"#FFDFD5"},
  {id:"300",n:"Mahogany Vy Dk",f:"Mahogany",hex:"#6F2F00"},
  {id:"301",n:"Mahogany Med",f:"Mahogany",hex:"#B35F2B"},
  {id:"304",n:"Red Medium",f:"Red",hex:"#B71F33"},
  {id:"307",n:"Lemon",f:"Lemon",hex:"#FDED54"},
  {id:"309",n:"Rose Dark",f:"Rose",hex:"#BA4A4A"},
  {id:"310",n:"Black",f:"Black",hex:"#000000"},
  {id:"311",n:"Wedgewood Ult VyDk",f:"Wedgewood",hex:"#1C5066"},
  {id:"312",n:"Baby Blue Very Dark",f:"Baby Blue",hex:"#35668B"},
  {id:"315",n:"Antique Mauve Md Dk",f:"Antique Mauve",hex:"#814952"},
  {id:"316",n:"Antique Mauve Med",f:"Antique Mauve",hex:"#B7737F"},
  {id:"317",n:"Pewter Gray",f:"Pewter Gray",hex:"#6C6C6C"},
  {id:"318",n:"Steel Gray Lt",f:"Steel Gray",hex:"#ABABAB"},
  {id:"319",n:"Pistachio Grn Vy Dk",f:"Pistachio Grn",hex:"#205F2E"},
  {id:"320",n:"Pistachio Green Med",f:"Pistachio Green",hex:"#69885A"},
  {id:"321",n:"Red",f:"Red",hex:"#C72B3B"},
  {id:"322",n:"Baby Blue Dark",f:"Baby Blue",hex:"#5A8FB8"},
  {id:"326",n:"Rose Very Dark",f:"Rose",hex:"#B33B4B"},
  {id:"327",n:"Violet Dark",f:"Violet",hex:"#633666"},
  {id:"333",n:"Blue Violet Very Dark",f:"Blue Violet",hex:"#5C5478"},
  {id:"334",n:"Baby Blue Medium",f:"Baby Blue",hex:"#739FC1"},
  {id:"335",n:"Rose",f:"Rose",hex:"#EE546E"},
  {id:"336",n:"Navy Blue",f:"Navy Blue",hex:"#253B73"},
  {id:"340",n:"Blue Violet Medium",f:"Blue Violet",hex:"#ADA7C7"},
  {id:"341",n:"Blue Violet Light",f:"Blue Violet",hex:"#B7BFDD"},
  {id:"347",n:"Salmon Very Dark",f:"Salmon",hex:"#BF2D2D"},
  {id:"349",n:"Coral Dark",f:"Coral",hex:"#D21035"},
  {id:"350",n:"Coral Medium",f:"Coral",hex:"#E04848"},
  {id:"351",n:"Coral",f:"Coral",hex:"#E96A67"},
  {id:"352",n:"Coral Light",f:"Coral",hex:"#FD9C97"},
  {id:"353",n:"Peach",f:"Peach",hex:"#FED7CC"},
  {id:"355",n:"Terra Cotta Dark",f:"Terra Cotta",hex:"#984436"},
  {id:"356",n:"Terra Cotta Med",f:"Terra Cotta",hex:"#C56A5B"},
  {id:"367",n:"Pistachio Green Dk",f:"Pistachio Green",hex:"#617A52"},
  {id:"368",n:"Pistachio Green Lt",f:"Pistachio Green",hex:"#A6C298"},
  {id:"369",n:"Pistachio Green Vy Lt",f:"Pistachio Green",hex:"#D7EDCC"},
  {id:"400",n:"Mahogany Dark",f:"Mahogany",hex:"#8F430F"},
  {id:"402",n:"Mahogany Vy Lt",f:"Mahogany",hex:"#F7A777"},
  {id:"407",n:"Desert Sand Med",f:"Desert Sand",hex:"#BB8161"},
  {id:"413",n:"Pewter Gray Dark",f:"Pewter Gray",hex:"#565656"},
  {id:"414",n:"Steel Gray Dk",f:"Steel Gray",hex:"#8C8C8C"},
  {id:"415",n:"Pearl Gray",f:"Pearl Gray",hex:"#D3D3D6"},
  {id:"420",n:"Hazelnut Brown Dk",f:"Hazelnut Brown",hex:"#A07042"},
  {id:"422",n:"Hazelnut Brown Lt",f:"Hazelnut Brown",hex:"#C69F7B"},
  {id:"433",n:"Brown Med",f:"Brown",hex:"#7A451F"},
  {id:"434",n:"Brown Light",f:"Brown",hex:"#985E33"},
  {id:"435",n:"Brown Very Light",f:"Brown",hex:"#B87748"},
  {id:"436",n:"Tan",f:"Tan",hex:"#CB9051"},
  {id:"437",n:"Tan Light",f:"Tan",hex:"#E4BB8E"},
  {id:"444",n:"Lemon Dark",f:"Lemon",hex:"#FFD600"},
  {id:"445",n:"Lemon Light",f:"Lemon",hex:"#FFFB8B"},
  {id:"451",n:"Shell Gray Dark",f:"Shell Gray",hex:"#917B73"},
  {id:"453",n:"Shell Gray Light",f:"Shell Gray",hex:"#D7CECB"},
  {id:"469",n:"Avocado Green",f:"Avocado Green",hex:"#72843C"},
  {id:"470",n:"Avocado Grn Lt",f:"Avocado Grn",hex:"#94AB4F"},
  {id:"471",n:"Avocado Grn V Lt",f:"Avocado Grn",hex:"#AEBF79"},
  {id:"472",n:"Avocado Grn U Lt",f:"Avocado Grn",hex:"#D8E498"},
  {id:"498",n:"Red Dark",f:"Red",hex:"#A7132B"},
  {id:"500",n:"Blue Green Vy Dk",f:"Blue Green",hex:"#044D33"},
  {id:"501",n:"Blue Green Dark",f:"Blue Green",hex:"#396F52"},
  {id:"502",n:"Blue Green",f:"Blue Green",hex:"#5B9071"},
  {id:"503",n:"Blue Green Med",f:"Blue Green",hex:"#7BAC94"},
  {id:"517",n:"Wedgewood Dark",f:"Wedgewood",hex:"#3B768F"},
  {id:"518",n:"Wedgewood Light",f:"Wedgewood",hex:"#4F93A7"},
  {id:"519",n:"Sky Blue",f:"Sky Blue",hex:"#7EB1C8"},
  {id:"524",n:"Fern Green Vy Lt",f:"Fern Green",hex:"#C4CDAC"},
  {id:"543",n:"Beige Brown Ult Vy Lt",f:"Beige Brown",hex:"#F2E3CE"},
  {id:"550",n:"Violet Very Dark",f:"Violet",hex:"#5C184E"},
  {id:"552",n:"Violet Medium",f:"Violet",hex:"#803A6B"},
  {id:"553",n:"Violet",f:"Violet",hex:"#A3638B"},
  {id:"554",n:"Violet Light",f:"Violet",hex:"#DBB3CB"},
  {id:"580",n:"Moss Green Dk",f:"Moss Green",hex:"#888D33"},
  {id:"581",n:"Moss Green",f:"Moss Green",hex:"#A7AE38"},
  {id:"597",n:"Turquoise",f:"Turquoise",hex:"#5BA3B3"},
  {id:"598",n:"Turquoise Light",f:"Turquoise",hex:"#90C3CC"},
  {id:"600",n:"Cranberry Very Dark",f:"Cranberry",hex:"#CD2F63"},
  {id:"601",n:"Cranberry Dark",f:"Cranberry",hex:"#D1286A"},
  {id:"602",n:"Cranberry Medium",f:"Cranberry",hex:"#E24874"},
  {id:"603",n:"Cranberry",f:"Cranberry",hex:"#FFA4BE"},
  {id:"604",n:"Cranberry Light",f:"Cranberry",hex:"#FFB0BE"},
  {id:"605",n:"Cranberry Very Light",f:"Cranberry",hex:"#FFC0CD"},
  {id:"606",n:"Orange-Red Bright",f:"Orange-Red",hex:"#FA3203"},
  {id:"608",n:"Burnt Orange Bright",f:"Burnt Orange",hex:"#FD5D35"},
  {id:"610",n:"Drab Brown Dk",f:"Drab Brown",hex:"#796047"},
  {id:"611",n:"Drab Brown",f:"Drab Brown",hex:"#967656"},
  {id:"612",n:"Drab Brown Lt",f:"Drab Brown",hex:"#BC9A78"},
  {id:"613",n:"Drab Brown V Lt",f:"Drab Brown",hex:"#DCC4AA"},
  {id:"632",n:"Desert Sand Ult Vy Dk",f:"Desert Sand",hex:"#875539"},
  {id:"640",n:"Beige Gray Vy Dk",f:"Beige Gray",hex:"#857B61"},
  {id:"642",n:"Beige Gray Dark",f:"Beige Gray",hex:"#A49878"},
  {id:"644",n:"Beige Gray Med",f:"Beige Gray",hex:"#DDD8CB"},
  {id:"645",n:"Beaver Gray Vy Dk",f:"Beaver Gray",hex:"#6E655C"},
  {id:"646",n:"Beaver Gray Dk",f:"Beaver Gray",hex:"#877D73"},
  {id:"647",n:"Beaver Gray Med",f:"Beaver Gray",hex:"#B0A69C"},
  {id:"648",n:"Beaver Gray Lt",f:"Beaver Gray",hex:"#BCB4AC"},
  {id:"666",n:"Bright Red",f:"Bright Red",hex:"#E31D42"},
  {id:"676",n:"Old Gold Lt",f:"Old Gold",hex:"#E5CE97"},
  {id:"677",n:"Old Gold Vy Lt",f:"Old Gold",hex:"#F5ECCB"},
  {id:"699",n:"Green",f:"Green",hex:"#056517"},
  {id:"700",n:"Green Bright",f:"Green",hex:"#07731B"},
  {id:"701",n:"Green Light",f:"Green",hex:"#3F8F29"},
  {id:"702",n:"Kelly Green",f:"Kelly Green",hex:"#47A72F"},
  {id:"703",n:"Chartreuse",f:"Chartreuse",hex:"#7BB547"},
  {id:"704",n:"Chartreuse Bright",f:"Chartreuse",hex:"#9ECF34"},
  {id:"712",n:"Cream",f:"Cream",hex:"#FFFBEF"},
  {id:"718",n:"Plum",f:"Plum",hex:"#9C2462"},
  {id:"725",n:"Topaz Med Lt",f:"Topaz",hex:"#FFC840"},
  {id:"726",n:"Topaz Light",f:"Topaz",hex:"#FDD755"},
  {id:"727",n:"Topaz Vy Lt",f:"Topaz",hex:"#FFF1AF"},
  {id:"729",n:"Old Gold Medium",f:"Old Gold",hex:"#D0A53E"},
  {id:"730",n:"Olive Green V Dk",f:"Olive Green",hex:"#827B30"},
  {id:"732",n:"Olive Green",f:"Olive Green",hex:"#948C36"},
  {id:"733",n:"Olive Green Md",f:"Olive Green",hex:"#BCB34C"},
  {id:"734",n:"Olive Green Lt",f:"Olive Green",hex:"#C7C077"},
  {id:"738",n:"Tan Very Light",f:"Tan",hex:"#ECCC9E"},
  {id:"739",n:"Tan Ult Vy Lt",f:"Tan",hex:"#F8E4C8"},
  {id:"740",n:"Tangerine",f:"Tangerine",hex:"#FF8B00"},
  {id:"741",n:"Tangerine Med",f:"Tangerine",hex:"#FFA32B"},
  {id:"742",n:"Tangerine Light",f:"Tangerine",hex:"#FFBF57"},
  {id:"743",n:"Yellow Med",f:"Yellow",hex:"#FED376"},
  {id:"744",n:"Yellow Pale",f:"Yellow",hex:"#FFE793"},
  {id:"745",n:"Yellow Pale Light",f:"Yellow",hex:"#FFE9AD"},
  {id:"746",n:"Off White",f:"Off White",hex:"#FCFCEE"},
  {id:"747",n:"Peacock Blue Vy Lt",f:"Peacock Blue",hex:"#E5FCFD"},
  {id:"754",n:"Peach Light",f:"Peach",hex:"#F7CBBF"},
  {id:"758",n:"Terra Cotta Vy Lt",f:"Terra Cotta",hex:"#EEAA9B"},
  {id:"760",n:"Salmon",f:"Salmon",hex:"#F5ADAD"},
  {id:"761",n:"Salmon Light",f:"Salmon",hex:"#FFC9C9"},
  {id:"762",n:"Pearl Gray Vy Lt",f:"Pearl Gray",hex:"#ECECEC"},
  {id:"775",n:"Baby Blue Very Light",f:"Baby Blue",hex:"#D9EBF1"},
  {id:"778",n:"Antique Mauve Vy Lt",f:"Antique Mauve",hex:"#DFB3BB"},
  {id:"780",n:"Topaz Ultra Vy Dk",f:"Topaz",hex:"#94631A"},
  {id:"782",n:"Topaz Dark",f:"Topaz",hex:"#AE7720"},
  {id:"783",n:"Topaz Medium",f:"Topaz",hex:"#CE9124"},
  {id:"791",n:"Cornflower Blue V D",f:"Cornflower Blue",hex:"#464563"},
  {id:"792",n:"Cornflower Blue Dark",f:"Cornflower Blue",hex:"#555B7B"},
  {id:"793",n:"Cornflower Blue Med",f:"Cornflower Blue",hex:"#707DA2"},
  {id:"794",n:"Cornflower Blue Light",f:"Cornflower Blue",hex:"#8F9CC1"},
  {id:"796",n:"Royal Blue Dark",f:"Royal Blue",hex:"#11416D"},
  {id:"797",n:"Royal Blue",f:"Royal Blue",hex:"#13477D"},
  {id:"798",n:"Delft Blue Dark",f:"Delft Blue",hex:"#466A8E"},
  {id:"799",n:"Delft Blue Medium",f:"Delft Blue",hex:"#748EB6"},
  {id:"800",n:"Delft Blue Pale",f:"Delft Blue",hex:"#C0CCDE"},
  {id:"801",n:"Coffee Brown Dk",f:"Coffee Brown",hex:"#653919"},
  {id:"807",n:"Peacock Blue",f:"Peacock Blue",hex:"#64ABBA"},
  {id:"809",n:"Delft Blue",f:"Delft Blue",hex:"#94A8C6"},
  {id:"813",n:"Blue Light",f:"Blue",hex:"#A1C2D7"},
  {id:"814",n:"Garnet Dark",f:"Garnet",hex:"#7B001B"},
  {id:"815",n:"Garnet Medium",f:"Garnet",hex:"#87071F"},
  {id:"816",n:"Garnet",f:"Garnet",hex:"#970B23"},
  {id:"817",n:"Coral Red Very Dark",f:"Coral Red",hex:"#BB051F"},
  {id:"818",n:"Baby Pink",f:"Baby Pink",hex:"#FFDFD9"},
  {id:"819",n:"Baby Pink Light",f:"Baby Pink",hex:"#FFEEEB"},
  {id:"820",n:"Royal Blue Very Dark",f:"Royal Blue",hex:"#0E365C"},
  {id:"822",n:"Beige Gray Light",f:"Beige Gray",hex:"#E7E2D3"},
  {id:"823",n:"Navy Blue Dark",f:"Navy Blue",hex:"#213063"},
  {id:"824",n:"Blue Very Dark",f:"Blue",hex:"#396987"},
  {id:"825",n:"Blue Dark",f:"Blue",hex:"#4781A5"},
  {id:"826",n:"Blue Medium",f:"Blue",hex:"#6B9EBF"},
  {id:"827",n:"Blue Very Light",f:"Blue",hex:"#BDDDED"},
  {id:"828",n:"Sky Blue Vy Lt",f:"Sky Blue",hex:"#C5E8ED"},
  {id:"829",n:"Golden Olive Vy Dk",f:"Golden Olive",hex:"#7E6B42"},
  {id:"830",n:"Golden Olive Dk",f:"Golden Olive",hex:"#8D784B"},
  {id:"832",n:"Golden Olive",f:"Golden Olive",hex:"#BD9B51"},
  {id:"834",n:"Golden Olive Vy Lt",f:"Golden Olive",hex:"#DBBE7F"},
  {id:"838",n:"Beige Brown Vy Dk",f:"Beige Brown",hex:"#594937"},
  {id:"839",n:"Beige Brown Dk",f:"Beige Brown",hex:"#675541"},
  {id:"840",n:"Beige Brown Med",f:"Beige Brown",hex:"#9A7C5C"},
  {id:"841",n:"Beige Brown Lt",f:"Beige Brown",hex:"#B69B7E"},
  {id:"842",n:"Beige Brown Vy Lt",f:"Beige Brown",hex:"#D1BAA1"},
  {id:"844",n:"Beaver Gray Ult Dk",f:"Beaver Gray",hex:"#484848"},
  {id:"869",n:"Hazelnut Brown V Dk",f:"Hazelnut Brown",hex:"#835E39"},
  {id:"890",n:"Pistachio Grn Ult V D",f:"Pistachio Grn",hex:"#174923"},
  {id:"891",n:"Carnation Dark",f:"Carnation",hex:"#FF5773"},
  {id:"892",n:"Carnation Medium",f:"Carnation",hex:"#FF798C"},
  {id:"893",n:"Carnation Light",f:"Carnation",hex:"#FC90A2"},
  {id:"894",n:"Carnation Very Light",f:"Carnation",hex:"#FFB2BB"},
  {id:"895",n:"Hunter Green Vy Dk",f:"Hunter Green",hex:"#1B5300"},
  {id:"898",n:"Coffee Brown Vy Dk",f:"Coffee Brown",hex:"#492A13"},
  {id:"899",n:"Rose Medium",f:"Rose",hex:"#F27688"},
  {id:"900",n:"Burnt Orange Dark",f:"Burnt Orange",hex:"#D15807"},
  {id:"902",n:"Garnet Very Dark",f:"Garnet",hex:"#822637"},
  {id:"904",n:"Parrot Green V Dk",f:"Parrot Green",hex:"#557822"},
  {id:"905",n:"Parrot Green Dk",f:"Parrot Green",hex:"#628A28"},
  {id:"906",n:"Parrot Green Md",f:"Parrot Green",hex:"#7FB335"},
  {id:"907",n:"Parrot Green Lt",f:"Parrot Green",hex:"#C7E666"},
  {id:"909",n:"Emerald Green Vy Dk",f:"Emerald Green",hex:"#156F49"},
  {id:"910",n:"Emerald Green Dark",f:"Emerald Green",hex:"#187E56"},
  {id:"911",n:"Emerald Green Med",f:"Emerald Green",hex:"#189065"},
  {id:"912",n:"Emerald Green Lt",f:"Emerald Green",hex:"#1B9D6B"},
  {id:"913",n:"Nile Green Med",f:"Nile Green",hex:"#6DAB77"},
  {id:"915",n:"Plum Dark",f:"Plum",hex:"#820043"},
  {id:"918",n:"Red-Copper Dark",f:"Red-Copper",hex:"#82340A"},
  {id:"919",n:"Red-Copper",f:"Red-Copper",hex:"#A64510"},
  {id:"920",n:"Copper Med",f:"Copper",hex:"#AC5414"},
  {id:"921",n:"Copper",f:"Copper",hex:"#C66218"},
  {id:"922",n:"Copper Light",f:"Copper",hex:"#E27323"},
  {id:"924",n:"Gray Green Vy Dark",f:"Gray Green",hex:"#566A6A"},
  {id:"926",n:"Gray Green Med",f:"Gray Green",hex:"#98AEAE"},
  {id:"927",n:"Gray Green Light",f:"Gray Green",hex:"#BDCBCB"},
  {id:"928",n:"Gray Green Vy Lt",f:"Gray Green",hex:"#DDE3E3"},
  {id:"930",n:"Antique Blue Dark",f:"Antique Blue",hex:"#455C71"},
  {id:"931",n:"Antique Blue Medium",f:"Antique Blue",hex:"#6A859E"},
  {id:"932",n:"Antique Blue Light",f:"Antique Blue",hex:"#A2B5C6"},
  {id:"934",n:"Avocado Grn Black",f:"Avocado Grn Black",hex:"#313919"},
  {id:"935",n:"Avocado Green Dk",f:"Avocado Green",hex:"#424D21"},
  {id:"936",n:"Avocado Grn V Dk",f:"Avocado Grn",hex:"#4C5826"},
  {id:"937",n:"Avocado Green Md",f:"Avocado Green",hex:"#627133"},
  {id:"938",n:"Coffee Brown Ult Dk",f:"Coffee Brown",hex:"#361F0E"},
  {id:"939",n:"Navy Blue Very Dark",f:"Navy Blue",hex:"#1B2853"},
  {id:"943",n:"Green Bright Md",f:"Green",hex:"#3D9384"},
  {id:"945",n:"Tawny",f:"Tawny",hex:"#FBD5BB"},
  {id:"946",n:"Burnt Orange Med",f:"Burnt Orange",hex:"#EB6307"},
  {id:"947",n:"Burnt Orange",f:"Burnt Orange",hex:"#FF7B4D"},
  {id:"948",n:"Peach Very Light",f:"Peach",hex:"#FEE7DA"},
  {id:"950",n:"Desert Sand Light",f:"Desert Sand",hex:"#EED3C4"},
  {id:"951",n:"Tawny Light",f:"Tawny",hex:"#FFE2CF"},
  {id:"954",n:"Nile Green",f:"Nile Green",hex:"#88BA91"},
  {id:"955",n:"Nile Green Light",f:"Nile Green",hex:"#A2D6AD"},
  {id:"956",n:"Geranium",f:"Geranium",hex:"#FF9191"},
  {id:"957",n:"Geranium Pale",f:"Geranium",hex:"#FDB5B5"},
  {id:"959",n:"Sea Green Med",f:"Sea Green",hex:"#59C7B4"},
  {id:"961",n:"Dusty Rose Dark",f:"Dusty Rose",hex:"#CF7373"},
  {id:"962",n:"Dusty Rose Medium",f:"Dusty Rose",hex:"#E68A8A"},
  {id:"963",n:"Dusty Rose Ult Vy Lt",f:"Dusty Rose",hex:"#FFD7D7"},
  {id:"966",n:"Jade Ultra Vy Lt",f:"Jade",hex:"#B9D7C0"},
  {id:"972",n:"Canary Deep",f:"Canary",hex:"#FFB515"},
  {id:"973",n:"Canary Bright",f:"Canary",hex:"#FFE300"},
  {id:"975",n:"Golden Brown Dk",f:"Golden Brown",hex:"#914F12"},
  {id:"976",n:"Golden Brown Med",f:"Golden Brown",hex:"#C28142"},
  {id:"977",n:"Golden Brown Light",f:"Golden Brown",hex:"#DC9C56"},
  {id:"986",n:"Forest Green Vy Dk",f:"Forest Green",hex:"#405230"},
  {id:"987",n:"Forest Green Dk",f:"Forest Green",hex:"#587141"},
  {id:"988",n:"Forest Green Med",f:"Forest Green",hex:"#738B5B"},
  {id:"989",n:"Forest Green",f:"Forest Green",hex:"#8DA675"},
  {id:"991",n:"Aquamarine Dk",f:"Aquamarine",hex:"#477B6E"},
  {id:"992",n:"Aquamarine Lt",f:"Aquamarine",hex:"#6FAE9F"},
  {id:"993",n:"Aquamarine Vy Lt",f:"Aquamarine",hex:"#90C0B4"},
  {id:"995",n:"Electric Blue Dark",f:"Electric Blue",hex:"#2696B6"},
  {id:"996",n:"Electric Blue Medium",f:"Electric Blue",hex:"#30C2EC"},
  {id:"3011",n:"Khaki Green Dk",f:"Khaki Green",hex:"#898A58"},
  {id:"3012",n:"Khaki Green Md",f:"Khaki Green",hex:"#A6A75D"},
  {id:"3013",n:"Khaki Green Lt",f:"Khaki Green",hex:"#B9B982"},
  {id:"3021",n:"Brown Gray Vy Dk",f:"Brown Gray",hex:"#4F4B41"},
  {id:"3022",n:"Brown Gray Med",f:"Brown Gray",hex:"#8E9078"},
  {id:"3024",n:"Brown Gray Vy Lt",f:"Brown Gray",hex:"#EBEAE7"},
  {id:"3033",n:"Mocha Brown Vy Lt",f:"Mocha Brown",hex:"#E3D8CC"},
  {id:"3041",n:"Antique Violet Medium",f:"Antique Violet",hex:"#956F7C"},
  {id:"3042",n:"Antique Violet Light",f:"Antique Violet",hex:"#B79DA7"},
  {id:"3045",n:"Yellow Beige Dk",f:"Yellow Beige",hex:"#BC966A"},
  {id:"3046",n:"Yellow Beige Md",f:"Yellow Beige",hex:"#D8BC9A"},
  {id:"3047",n:"Yellow Beige Lt",f:"Yellow Beige",hex:"#E7D6C1"},
  {id:"3051",n:"Green Gray Dk",f:"Green Gray",hex:"#5F6648"},
  {id:"3052",n:"Green Gray Md",f:"Green Gray",hex:"#889268"},
  {id:"3053",n:"Green Gray",f:"Green Gray",hex:"#9CA482"},
  {id:"3072",n:"Beaver Gray Vy Lt",f:"Beaver Gray",hex:"#E6E8E8"},
  {id:"3078",n:"Golden Yellow Vy Lt",f:"Golden Yellow",hex:"#FDF9CD"},
  {id:"3325",n:"Baby Blue Light",f:"Baby Blue",hex:"#B8D2E6"},
  {id:"3326",n:"Rose Light",f:"Rose",hex:"#FBADB4"},
  {id:"3328",n:"Salmon Dark",f:"Salmon",hex:"#E36D6D"},
  {id:"3345",n:"Hunter Green Dk",f:"Hunter Green",hex:"#1B5915"},
  {id:"3346",n:"Hunter Green",f:"Hunter Green",hex:"#406A3A"},
  {id:"3347",n:"Yellow Green Med",f:"Yellow Green",hex:"#71935C"},
  {id:"3348",n:"Yellow Green Lt",f:"Yellow Green",hex:"#CCD9B1"},
  {id:"3350",n:"Dusty Rose Ultra Dark",f:"Dusty Rose",hex:"#BC4365"},
  {id:"3354",n:"Dusty Rose Light",f:"Dusty Rose",hex:"#E4A6AC"},
  {id:"3371",n:"Black Brown",f:"Black Brown",hex:"#1E1108"},
  {id:"3685",n:"Mauve Very Dark",f:"Mauve",hex:"#881531"},
  {id:"3687",n:"Mauve",f:"Mauve",hex:"#C96B70"},
  {id:"3688",n:"Mauve Medium",f:"Mauve",hex:"#E7A9AC"},
  {id:"3689",n:"Mauve Light",f:"Mauve",hex:"#FBBFC2"},
  {id:"3731",n:"Dusty Rose Very Dark",f:"Dusty Rose",hex:"#DA6783"},
  {id:"3743",n:"Antique Violet Vy Lt",f:"Antique Violet",hex:"#D7CBD3"},
  {id:"3753",n:"Antique Blue Ult Vy Lt",f:"Antique Blue",hex:"#DBE2E9"},
  {id:"3760",n:"Wedgewood Med",f:"Wedgewood",hex:"#3E85A2"},
  {id:"3799",n:"Pewter Gray Vy Dk",f:"Pewter Gray",hex:"#424242"},
  {id:"3801",n:"Melon Very Dark",f:"Melon",hex:"#E74967"},
  {id:"3813",n:"Blue Green Lt",f:"Blue Green",hex:"#B2D4BD"},
  {id:"3814",n:"Aquamarine",f:"Aquamarine",hex:"#508B7D"},
  {id:"3823",n:"Yellow Ultra Pale",f:"Yellow",hex:"#FFFDE3"},
  {id:"3844",n:"Turquoise Bright Dark",f:"Turquoise",hex:"#12AEBA"},
  {id:"3846",n:"Turquoise Bright Light",f:"Turquoise",hex:"#06E3E6"},
  {id:"3847",n:"Teal Green Dark",f:"Teal Green",hex:"#347D75"},
  {id:"3865",n:"Winter White",f:"Winter White",hex:"#F9F7F1"},
  {id:"1",n:"Grey",f:"Grey",hex:"#BCBCBB"},
  {id:"3",n:"Grey",f:"Grey",hex:"#909093"},
  {id:"30",n:"Purple",f:"Purple",hex:"#6A6386"},
  {id:"32",n:"Purple",f:"Purple",hex:"#393358"},
  {id:"33",n:"Pink, Purple",f:"Pink",hex:"#743560"},
  {id:"34",n:"Pink",f:"Pink",hex:"#581731"},
  {id:"35",n:"Pink",f:"Pink",hex:"#3C0D1C"},
  {id:"ecru",n:"Ecru",f:"Ecru",hex:"#F0EADA"},
  {id:"B5200",n:"Snow White",f:"Snow White",hex:"#FFFFFF"},
  {id:"blanc",n:"White",f:"White",hex:"#FCFBF8"},
];
export const APPLETONS_PALETTE: any = [
  {id:"101",n:"Purple 101",f:"Purple",hex:"#CFADE0"},
  {id:"102",n:"Purple 102",f:"Purple",hex:"#BA89D3"},
  {id:"103",n:"Purple 103",f:"Purple",hex:"#A663C8"},
  {id:"104",n:"Purple 104",f:"Purple",hex:"#913FBA"},
  {id:"105",n:"Purple 105",f:"Purple",hex:"#753297"},
  {id:"106",n:"Purple 106",f:"Purple",hex:"#592474"},
  {id:"121",n:"Terra Cotta 121",f:"Terra Cotta",hex:"#E8BDAF"},
  {id:"122",n:"Terra Cotta 122",f:"Terra Cotta",hex:"#E0A594"},
  {id:"123",n:"Terra Cotta 123",f:"Terra Cotta",hex:"#DA8E77"},
  {id:"124",n:"Terra Cotta 124",f:"Terra Cotta",hex:"#D4775A"},
  {id:"125",n:"Terra Cotta 125",f:"Terra Cotta",hex:"#CE5F3D"},
  {id:"126",n:"Terra Cotta 126",f:"Terra Cotta",hex:"#BB4E2D"},
  {id:"127",n:"Terra Cotta 127",f:"Terra Cotta",hex:"#A04225"},
  {id:"128",n:"Terra Cotta 128",f:"Terra Cotta",hex:"#85361D"},
  {id:"141",n:"Dull Rose Pink 141",f:"Dull Rose Pink",hex:"#E6CBCF"},
  {id:"142",n:"Dull Rose Pink 142",f:"Dull Rose Pink",hex:"#DCB6BD"},
  {id:"143",n:"Dull Rose Pink 143",f:"Dull Rose Pink",hex:"#D3A2AA"},
  {id:"144",n:"Dull Rose Pink 144",f:"Dull Rose Pink",hex:"#CA8D97"},
  {id:"145",n:"Dull Rose Pink 145",f:"Dull Rose Pink",hex:"#C17784"},
  {id:"146",n:"Dull Rose Pink 146",f:"Dull Rose Pink",hex:"#B96270"},
  {id:"147",n:"Dull Rose Pink 147",f:"Dull Rose Pink",hex:"#B04D5D"},
  {id:"148",n:"Dull Rose Pink 148",f:"Dull Rose Pink",hex:"#9C4352"},
  {id:"149",n:"Dull Rose Pink 149",f:"Dull Rose Pink",hex:"#873946"},
  {id:"151",n:"Mid Blue 151",f:"Mid Blue",hex:"#BACDE8"},
  {id:"152",n:"Mid Blue 152",f:"Mid Blue",hex:"#A0BBE0"},
  {id:"153",n:"Mid Blue 153",f:"Mid Blue",hex:"#86A9D8"},
  {id:"154",n:"Mid Blue 154",f:"Mid Blue",hex:"#6C96D1"},
  {id:"155",n:"Mid Blue 155",f:"Mid Blue",hex:"#5284CB"},
  {id:"156",n:"Mid Blue 156",f:"Mid Blue",hex:"#3972C3"},
  {id:"157",n:"Mid Blue 157",f:"Mid Blue",hex:"#3063AA"},
  {id:"158",n:"Mid Blue 158",f:"Mid Blue",hex:"#285491"},
  {id:"159",n:"Mid Blue 159",f:"Mid Blue",hex:"#204578"},
  {id:"181",n:"Chocolate 181",f:"Chocolate",hex:"#D7B297"},
  {id:"182",n:"Chocolate 182",f:"Chocolate",hex:"#CC9975"},
  {id:"183",n:"Chocolate 183",f:"Chocolate",hex:"#C18052"},
  {id:"184",n:"Chocolate 184",f:"Chocolate",hex:"#AA693B"},
  {id:"185",n:"Chocolate 185",f:"Chocolate",hex:"#89542E"},
  {id:"186",n:"Chocolate 186",f:"Chocolate",hex:"#673F21"},
  {id:"187",n:"Chocolate 187",f:"Chocolate",hex:"#452916"},
  {id:"201",n:"Flame Red 201",f:"Flame Red",hex:"#F3AEA4"},
  {id:"202",n:"Flame Red 202",f:"Flame Red",hex:"#F19789"},
  {id:"203",n:"Flame Red 203",f:"Flame Red",hex:"#EF7F6D"},
  {id:"204",n:"Flame Red 204",f:"Flame Red",hex:"#EE6651"},
  {id:"205",n:"Flame Red 205",f:"Flame Red",hex:"#ED4D35"},
  {id:"206",n:"Flame Red 206",f:"Flame Red",hex:"#EC3418"},
  {id:"207",n:"Flame Red 207",f:"Flame Red",hex:"#D82A0F"},
  {id:"208",n:"Flame Red 208",f:"Flame Red",hex:"#BE230B"},
  {id:"209",n:"Flame Red 209",f:"Flame Red",hex:"#A41D08"},
  {id:"221",n:"Bright Terra Cotta 221",f:"Bright Terra Cotta",hex:"#EDBCAA"},
  {id:"222",n:"Bright Terra Cotta 222",f:"Bright Terra Cotta",hex:"#E7A289"},
  {id:"223",n:"Bright Terra Cotta 223",f:"Bright Terra Cotta",hex:"#E28867"},
  {id:"224",n:"Bright Terra Cotta 224",f:"Bright Terra Cotta",hex:"#DD6D44"},
  {id:"225",n:"Bright Terra Cotta 225",f:"Bright Terra Cotta",hex:"#D75323"},
  {id:"226",n:"Bright Terra Cotta 226",f:"Bright Terra Cotta",hex:"#B7451C"},
  {id:"227",n:"Bright Terra Cotta 227",f:"Bright Terra Cotta",hex:"#973815"},
  {id:"241",n:"Olive Green 241",f:"Olive Green",hex:"#CFDB93"},
  {id:"242",n:"Olive Green 242",f:"Olive Green",hex:"#BECF69"},
  {id:"243",n:"Olive Green 243",f:"Olive Green",hex:"#AEC53E"},
  {id:"244",n:"Olive Green 244",f:"Olive Green",hex:"#8DA02D"},
  {id:"245",n:"Olive Green 245",f:"Olive Green",hex:"#697820"},
  {id:"251a",n:"Grass Green 251a",f:"Grass Green",hex:"#BCE5A8"},
  {id:"251",n:"Grass Green 251",f:"Grass Green",hex:"#A3DD86"},
  {id:"252",n:"Grass Green 252",f:"Grass Green",hex:"#89D563"},
  {id:"253",n:"Grass Green 253",f:"Grass Green",hex:"#6FCE40"},
  {id:"254",n:"Grass Green 254",f:"Grass Green",hex:"#5AB62C"},
  {id:"255",n:"Grass Green 255",f:"Grass Green",hex:"#499523"},
  {id:"256",n:"Grass Green 256",f:"Grass Green",hex:"#38741A"},
  {id:"291a",n:"Jacobean Green 291a",f:"Jacobean Green",hex:"#ADE0B6"},
  {id:"291",n:"Jacobean Green 291",f:"Jacobean Green",hex:"#93D69E"},
  {id:"292",n:"Jacobean Green 292",f:"Jacobean Green",hex:"#78CE86"},
  {id:"293",n:"Jacobean Green 293",f:"Jacobean Green",hex:"#5DC56E"},
  {id:"294",n:"Jacobean Green 294",f:"Jacobean Green",hex:"#41BD56"},
  {id:"295",n:"Jacobean Green 295",f:"Jacobean Green",hex:"#37A349"},
  {id:"296",n:"Jacobean Green 296",f:"Jacobean Green",hex:"#2D893D"},
  {id:"297",n:"Jacobean Green 297",f:"Jacobean Green",hex:"#246F30"},
  {id:"298",n:"Jacobean Green 298",f:"Jacobean Green",hex:"#1B5524"},
  {id:"301",n:"Red Fawn 301",f:"Red Fawn",hex:"#DEC8C3"},
  {id:"302",n:"Red Fawn 302",f:"Red Fawn",hex:"#CDAAA1"},
  {id:"303",n:"Red Fawn 303",f:"Red Fawn",hex:"#BD8B7E"},
  {id:"304",n:"Red Fawn 304",f:"Red Fawn",hex:"#AD6C5B"},
  {id:"305",n:"Red Fawn 305",f:"Red Fawn",hex:"#905446"},
  {id:"311",n:"Brown Olive 311",f:"Brown Olive",hex:"#D1C693"},
  {id:"312",n:"Brown Olive 312",f:"Brown Olive",hex:"#C3B570"},
  {id:"313",n:"Brown Olive 313",f:"Brown Olive",hex:"#B6A54C"},
  {id:"314",n:"Brown Olive 314",f:"Brown Olive",hex:"#96873B"},
  {id:"315",n:"Brown Olive 315",f:"Brown Olive",hex:"#74682C"},
  {id:"316",n:"Brown Olive 316",f:"Brown Olive",hex:"#51491E"},
  {id:"321",n:"Dull Marine Blue 321",f:"Dull Marine Blue",hex:"#B1CADC"},
  {id:"322",n:"Dull Marine Blue 322",f:"Dull Marine Blue",hex:"#96B8D1"},
  {id:"323",n:"Dull Marine Blue 323",f:"Dull Marine Blue",hex:"#7BA7C6"},
  {id:"324",n:"Dull Marine Blue 324",f:"Dull Marine Blue",hex:"#6095BB"},
  {id:"325",n:"Dull Marine Blue 325",f:"Dull Marine Blue",hex:"#4883AD"},
  {id:"326",n:"Dull Marine Blue 326",f:"Dull Marine Blue",hex:"#3C6F94"},
  {id:"327",n:"Dull Marine Blue 327",f:"Dull Marine Blue",hex:"#305B79"},
  {id:"328",n:"Dull Marine Blue 328",f:"Dull Marine Blue",hex:"#25475F"},
  {id:"331a",n:"Drab Green 331a",f:"Drab Green",hex:"#BCD0A8"},
  {id:"331",n:"Drab Green 331",f:"Drab Green",hex:"#AEC695"},
  {id:"332",n:"Drab Green 332",f:"Drab Green",hex:"#9FBD81"},
  {id:"333",n:"Drab Green 333",f:"Drab Green",hex:"#90B36D"},
  {id:"334",n:"Drab Green 334",f:"Drab Green",hex:"#82AA59"},
  {id:"335",n:"Drab Green 335",f:"Drab Green",hex:"#73994D"},
  {id:"336",n:"Drab Green 336",f:"Drab Green",hex:"#648643"},
  {id:"337",n:"Drab Green 337",f:"Drab Green",hex:"#567338"},
  {id:"338",n:"Drab Green 338",f:"Drab Green",hex:"#47602E"},
  {id:"341",n:"Mid Olive Green 341",f:"Mid Olive Green",hex:"#CCDC9C"},
  {id:"342",n:"Mid Olive Green 342",f:"Mid Olive Green",hex:"#BFD482"},
  {id:"343",n:"Mid Olive Green 343",f:"Mid Olive Green",hex:"#B3CC67"},
  {id:"344",n:"Mid Olive Green 344",f:"Mid Olive Green",hex:"#A6C44B"},
  {id:"345",n:"Mid Olive Green 345",f:"Mid Olive Green",hex:"#95B438"},
  {id:"346",n:"Mid Olive Green 346",f:"Mid Olive Green",hex:"#809B2F"},
  {id:"347",n:"Mid Olive Green 347",f:"Mid Olive Green",hex:"#6A8126"},
  {id:"348",n:"Mid Olive Green 348",f:"Mid Olive Green",hex:"#54661D"},
  {id:"351",n:"Grey Green 351",f:"Grey Green",hex:"#B5CEBD"},
  {id:"352",n:"Grey Green 352",f:"Grey Green",hex:"#A1C0AB"},
  {id:"353",n:"Grey Green 353",f:"Grey Green",hex:"#8CB499"},
  {id:"354",n:"Grey Green 354",f:"Grey Green",hex:"#77A787"},
  {id:"355",n:"Grey Green 355",f:"Grey Green",hex:"#639A75"},
  {id:"356",n:"Grey Green 356",f:"Grey Green",hex:"#558665"},
  {id:"357",n:"Grey Green 357",f:"Grey Green",hex:"#487256"},
  {id:"358",n:"Grey Green 358",f:"Grey Green",hex:"#3A5E46"},
  {id:"401",n:"Sea Green 401",f:"Sea Green",hex:"#B7E0D6"},
  {id:"402",n:"Sea Green 402",f:"Sea Green",hex:"#99D4C5"},
  {id:"403",n:"Sea Green 403",f:"Sea Green",hex:"#7AC8B5"},
  {id:"404",n:"Sea Green 404",f:"Sea Green",hex:"#5ABDA4"},
  {id:"405",n:"Sea Green 405",f:"Sea Green",hex:"#42AB91"},
  {id:"406",n:"Sea Green 406",f:"Sea Green",hex:"#358D77"},
  {id:"407",n:"Sea Green 407",f:"Sea Green",hex:"#296F5E"},
  {id:"421",n:"Leaf Green 421",f:"Leaf Green",hex:"#B2E5A8"},
  {id:"422",n:"Leaf Green 422",f:"Leaf Green",hex:"#9BDF8D"},
  {id:"423",n:"Leaf Green 423",f:"Leaf Green",hex:"#83D872"},
  {id:"424",n:"Leaf Green 424",f:"Leaf Green",hex:"#6CD257"},
  {id:"425",n:"Leaf Green 425",f:"Leaf Green",hex:"#54CC3C"},
  {id:"426",n:"Leaf Green 426",f:"Leaf Green",hex:"#45B92E"},
  {id:"427",n:"Leaf Green 427",f:"Leaf Green",hex:"#3AA026"},
  {id:"428",n:"Leaf Green 428",f:"Leaf Green",hex:"#30861F"},
  {id:"429",n:"Leaf Green 429",f:"Leaf Green",hex:"#266C18"},
  {id:"431",n:"Signal Green 431",f:"Signal Green",hex:"#9DE6BB"},
  {id:"432",n:"Signal Green 432",f:"Signal Green",hex:"#7DDFA6"},
  {id:"433",n:"Signal Green 433",f:"Signal Green",hex:"#5DD991"},
  {id:"434",n:"Signal Green 434",f:"Signal Green",hex:"#3DD47C"},
  {id:"435",n:"Signal Green 435",f:"Signal Green",hex:"#29C269"},
  {id:"436",n:"Signal Green 436",f:"Signal Green",hex:"#21A458"},
  {id:"437",n:"Signal Green 437",f:"Signal Green",hex:"#198647"},
  {id:"438",n:"Signal Green 438",f:"Signal Green",hex:"#126736"},
  {id:"441",n:"Orange Red 441",f:"Orange Red",hex:"#F5C2AC"},
  {id:"442",n:"Orange Red 442",f:"Orange Red",hex:"#F3AB8D"},
  {id:"443",n:"Orange Red 443",f:"Orange Red",hex:"#F1956D"},
  {id:"444",n:"Orange Red 444",f:"Orange Red",hex:"#F07E4C"},
  {id:"445",n:"Orange Red 445",f:"Orange Red",hex:"#F0662B"},
  {id:"446",n:"Orange Red 446",f:"Orange Red",hex:"#EC500E"},
  {id:"447",n:"Orange Red 447",f:"Orange Red",hex:"#CE450A"},
  {id:"448",n:"Orange Red 448",f:"Orange Red",hex:"#B03A07"},
  {id:"451",n:"Bright Mauve 451",f:"Bright Mauve",hex:"#E4BDDD"},
  {id:"452",n:"Bright Mauve 452",f:"Bright Mauve",hex:"#D79ACC"},
  {id:"453",n:"Bright Mauve 453",f:"Bright Mauve",hex:"#CA75BC"},
  {id:"454",n:"Bright Mauve 454",f:"Bright Mauve",hex:"#BE51AC"},
  {id:"455",n:"Bright Mauve 455",f:"Bright Mauve",hex:"#A33A92"},
  {id:"456",n:"Bright Mauve 456",f:"Bright Mauve",hex:"#802C72"},
  {id:"461",n:"Cornflower 461",f:"Cornflower",hex:"#B7C4EA"},
  {id:"462",n:"Cornflower 462",f:"Cornflower",hex:"#869CDE"},
  {id:"463",n:"Cornflower 463",f:"Cornflower",hex:"#5474D3"},
  {id:"464",n:"Cornflower 464",f:"Cornflower",hex:"#2D51BD"},
  {id:"465",n:"Cornflower 465",f:"Cornflower",hex:"#1F3B8D"},
  {id:"471",n:"Autumn Yellow 471",f:"Autumn Yellow",hex:"#F1E5BF"},
  {id:"472",n:"Autumn Yellow 472",f:"Autumn Yellow",hex:"#EDDBA7"},
  {id:"473",n:"Autumn Yellow 473",f:"Autumn Yellow",hex:"#E9D28E"},
  {id:"474",n:"Autumn Yellow 474",f:"Autumn Yellow",hex:"#E5C975"},
  {id:"475",n:"Autumn Yellow 475",f:"Autumn Yellow",hex:"#E2C05C"},
  {id:"476",n:"Autumn Yellow 476",f:"Autumn Yellow",hex:"#DFB842"},
  {id:"477",n:"Autumn Yellow 477",f:"Autumn Yellow",hex:"#DCAF28"},
  {id:"478",n:"Autumn Yellow 478",f:"Autumn Yellow",hex:"#C99F1E"},
  {id:"479",n:"Autumn Yellow 479",f:"Autumn Yellow",hex:"#B28C19"},
  {id:"481",n:"Kingfisher 481",f:"Kingfisher",hex:"#AFE3E8"},
  {id:"482",n:"Kingfisher 482",f:"Kingfisher",hex:"#95DAE1"},
  {id:"483",n:"Kingfisher 483",f:"Kingfisher",hex:"#7AD2DA"},
  {id:"484",n:"Kingfisher 484",f:"Kingfisher",hex:"#5FCBD4"},
  {id:"485",n:"Kingfisher 485",f:"Kingfisher",hex:"#44C3CF"},
  {id:"486",n:"Kingfisher 486",f:"Kingfisher",hex:"#30B5C1"},
  {id:"487",n:"Kingfisher 487",f:"Kingfisher",hex:"#289DA8"},
  {id:"488",n:"Kingfisher 488",f:"Kingfisher",hex:"#21858E"},
  {id:"489",n:"Kingfisher 489",f:"Kingfisher",hex:"#1A6D74"},
  {id:"501a",n:"Scarlet 501a",f:"Scarlet",hex:"#F7A3A0"},
  {id:"501",n:"Scarlet 501",f:"Scarlet",hex:"#F57975"},
  {id:"502",n:"Scarlet 502",f:"Scarlet",hex:"#F54E48"},
  {id:"503",n:"Scarlet 503",f:"Scarlet",hex:"#F6221B"},
  {id:"504",n:"Scarlet 504",f:"Scarlet",hex:"#DE0C05"},
  {id:"505",n:"Scarlet 505",f:"Scarlet",hex:"#B50802"},
  {id:"521",n:"Turquoise 521",f:"Turquoise",hex:"#B7EAE6"},
  {id:"522",n:"Turquoise 522",f:"Turquoise",hex:"#9DE3DD"},
  {id:"523",n:"Turquoise 523",f:"Turquoise",hex:"#82DDD5"},
  {id:"524",n:"Turquoise 524",f:"Turquoise",hex:"#67D6CD"},
  {id:"525",n:"Turquoise 525",f:"Turquoise",hex:"#4CD1C6"},
  {id:"526",n:"Turquoise 526",f:"Turquoise",hex:"#32CABD"},
  {id:"527",n:"Turquoise 527",f:"Turquoise",hex:"#2AB0A5"},
  {id:"528",n:"Turquoise 528",f:"Turquoise",hex:"#23968D"},
  {id:"529",n:"Turquoise 529",f:"Turquoise",hex:"#1C7C74"},
  {id:"541",n:"Early English Green 541",f:"Early English Green",hex:"#A8DBA8"},
  {id:"542",n:"Early English Green 542",f:"Early English Green",hex:"#8DD18D"},
  {id:"543",n:"Early English Green 543",f:"Early English Green",hex:"#72C872"},
  {id:"544",n:"Early English Green 544",f:"Early English Green",hex:"#57BE57"},
  {id:"545",n:"Early English Green 545",f:"Early English Green",hex:"#41B041"},
  {id:"546",n:"Early English Green 546",f:"Early English Green",hex:"#369636"},
  {id:"547",n:"Early English Green 547",f:"Early English Green",hex:"#2C7C2C"},
  {id:"548",n:"Early English Green 548",f:"Early English Green",hex:"#226222"},
  {id:"551",n:"Bright Yellow 551",f:"Bright Yellow",hex:"#F8F2C7"},
  {id:"552",n:"Bright Yellow 552",f:"Bright Yellow",hex:"#F6EBA6"},
  {id:"553",n:"Bright Yellow 553",f:"Bright Yellow",hex:"#F4E585"},
  {id:"554",n:"Bright Yellow 554",f:"Bright Yellow",hex:"#F3DF62"},
  {id:"555",n:"Bright Yellow 555",f:"Bright Yellow",hex:"#F2DA3F"},
  {id:"556",n:"Bright Yellow 556",f:"Bright Yellow",hex:"#F3D61B"},
  {id:"557",n:"Bright Yellow 557",f:"Bright Yellow",hex:"#E1C409"},
  {id:"561",n:"Sky Blue 561",f:"Sky Blue",hex:"#CCDBEA"},
  {id:"562",n:"Sky Blue 562",f:"Sky Blue",hex:"#B1C9E0"},
  {id:"563",n:"Sky Blue 563",f:"Sky Blue",hex:"#97B6D6"},
  {id:"564",n:"Sky Blue 564",f:"Sky Blue",hex:"#7CA4CD"},
  {id:"565",n:"Sky Blue 565",f:"Sky Blue",hex:"#6092C3"},
  {id:"566",n:"Sky Blue 566",f:"Sky Blue",hex:"#4580BB"},
  {id:"567",n:"Sky Blue 567",f:"Sky Blue",hex:"#396EA2"},
  {id:"568",n:"Sky Blue 568",f:"Sky Blue",hex:"#2F5B88"},
  {id:"581",n:"Brown Groundings 581",f:"Brown Groundings",hex:"#CFB295"},
  {id:"582",n:"Brown Groundings 582",f:"Brown Groundings",hex:"#C49F7A"},
  {id:"583",n:"Brown Groundings 583",f:"Brown Groundings",hex:"#B98C5F"},
  {id:"584",n:"Brown Groundings 584",f:"Brown Groundings",hex:"#AA7948"},
  {id:"585",n:"Brown Groundings 585",f:"Brown Groundings",hex:"#91663C"},
  {id:"586",n:"Brown Groundings 586",f:"Brown Groundings",hex:"#775330"},
  {id:"587",n:"Brown Groundings 587",f:"Brown Groundings",hex:"#5C4025"},
  {id:"588",n:"Brown Groundings 588",f:"Brown Groundings",hex:"#412D19"},
  {id:"601",n:"Mauve 601",f:"Mauve",hex:"#E1C1D6"},
  {id:"602",n:"Mauve 602",f:"Mauve",hex:"#D4A4C4"},
  {id:"603",n:"Mauve 603",f:"Mauve",hex:"#C888B2"},
  {id:"604",n:"Mauve 604",f:"Mauve",hex:"#BC6BA1"},
  {id:"605",n:"Mauve 605",f:"Mauve",hex:"#B04E8F"},
  {id:"606",n:"Mauve 606",f:"Mauve",hex:"#954079"},
  {id:"607",n:"Mauve 607",f:"Mauve",hex:"#793362"},
  {id:"621",n:"Flamingo 621",f:"Flamingo",hex:"#ECC3BF"},
  {id:"622",n:"Flamingo 622",f:"Flamingo",hex:"#E3A19B"},
  {id:"623",n:"Flamingo 623",f:"Flamingo",hex:"#DB7F77"},
  {id:"624",n:"Flamingo 624",f:"Flamingo",hex:"#D35C52"},
  {id:"625",n:"Flamingo 625",f:"Flamingo",hex:"#C93C2F"},
  {id:"626",n:"Flamingo 626",f:"Flamingo",hex:"#A63025"},
  {id:"641",n:"Peacock Blue 641",f:"Peacock Blue",hex:"#AEDFE9"},
  {id:"642",n:"Peacock Blue 642",f:"Peacock Blue",hex:"#89D2E1"},
  {id:"643",n:"Peacock Blue 643",f:"Peacock Blue",hex:"#63C5D9"},
  {id:"644",n:"Peacock Blue 644",f:"Peacock Blue",hex:"#3CB8D1"},
  {id:"645",n:"Peacock Blue 645",f:"Peacock Blue",hex:"#289FB7"},
  {id:"646",n:"Peacock Blue 646",f:"Peacock Blue",hex:"#1F8093"},
  {id:"647",n:"Peacock Blue 647",f:"Peacock Blue",hex:"#165F6E"},
  {id:"691",n:"Honeysuckle Yellow 691",f:"Honeysuckle Yellow",hex:"#ECE3BF"},
  {id:"692",n:"Honeysuckle Yellow 692",f:"Honeysuckle Yellow",hex:"#E5D7A2"},
  {id:"693",n:"Honeysuckle Yellow 693",f:"Honeysuckle Yellow",hex:"#DECC85"},
  {id:"694",n:"Honeysuckle Yellow 694",f:"Honeysuckle Yellow",hex:"#D7C167"},
  {id:"695",n:"Honeysuckle Yellow 695",f:"Honeysuckle Yellow",hex:"#D1B649"},
  {id:"696",n:"Honeysuckle Yellow 696",f:"Honeysuckle Yellow",hex:"#C6A830"},
  {id:"697",n:"Honeysuckle Yellow 697",f:"Honeysuckle Yellow",hex:"#AA8F27"},
  {id:"698",n:"Honeysuckle Yellow 698",f:"Honeysuckle Yellow",hex:"#8D771F"},
  {id:"701",n:"Flesh Tints 701",f:"Flesh Tints",hex:"#EFE2DB"},
  {id:"702",n:"Flesh Tints 702",f:"Flesh Tints",hex:"#E7D2C6"},
  {id:"703",n:"Flesh Tints 703",f:"Flesh Tints",hex:"#DFC2B1"},
  {id:"704",n:"Flesh Tints 704",f:"Flesh Tints",hex:"#D7B19C"},
  {id:"705",n:"Flesh Tints 705",f:"Flesh Tints",hex:"#CFA186"},
  {id:"706",n:"Flesh Tints 706",f:"Flesh Tints",hex:"#C89171"},
  {id:"707",n:"Flesh Tints 707",f:"Flesh Tints",hex:"#C1805B"},
  {id:"708",n:"Flesh Tints 708",f:"Flesh Tints",hex:"#BA6F44"},
  {id:"711",n:"Wine Red 711",f:"Wine Red",hex:"#DC889D"},
  {id:"712",n:"Wine Red 712",f:"Wine Red",hex:"#D3627E"},
  {id:"713",n:"Wine Red 713",f:"Wine Red",hex:"#CB3B5F"},
  {id:"714",n:"Wine Red 714",f:"Wine Red",hex:"#AC2B4B"},
  {id:"715",n:"Wine Red 715",f:"Wine Red",hex:"#88203A"},
  {id:"716",n:"Wine Red 716",f:"Wine Red",hex:"#631629"},
  {id:"721",n:"Paprika 721",f:"Paprika",hex:"#EEB99F"},
  {id:"722",n:"Paprika 722",f:"Paprika",hex:"#E99D77"},
  {id:"723",n:"Paprika 723",f:"Paprika",hex:"#E4814F"},
  {id:"724",n:"Paprika 724",f:"Paprika",hex:"#E16425"},
  {id:"725",n:"Paprika 725",f:"Paprika",hex:"#C25017"},
  {id:"726",n:"Paprika 726",f:"Paprika",hex:"#9C3F10"},
  {id:"741",n:"Bright China Blue 741",f:"Bright China Blue",hex:"#BFD7EC"},
  {id:"742",n:"Bright China Blue 742",f:"Bright China Blue",hex:"#A4C7E5"},
  {id:"743",n:"Bright China Blue 743",f:"Bright China Blue",hex:"#88B6DE"},
  {id:"744",n:"Bright China Blue 744",f:"Bright China Blue",hex:"#6CA6D8"},
  {id:"745",n:"Bright China Blue 745",f:"Bright China Blue",hex:"#5095D2"},
  {id:"746",n:"Bright China Blue 746",f:"Bright China Blue",hex:"#3385CC"},
  {id:"747",n:"Bright China Blue 747",f:"Bright China Blue",hex:"#2B73B2"},
  {id:"748",n:"Bright China Blue 748",f:"Bright China Blue",hex:"#236198"},
  {id:"749",n:"Bright China Blue 749",f:"Bright China Blue",hex:"#1C4F7C"},
  {id:"751",n:"Rose Pink 751",f:"Rose Pink",hex:"#EDC9CC"},
  {id:"752",n:"Rose Pink 752",f:"Rose Pink",hex:"#E5B2B6"},
  {id:"753",n:"Rose Pink 753",f:"Rose Pink",hex:"#DF9AA0"},
  {id:"754",n:"Rose Pink 754",f:"Rose Pink",hex:"#D88289"},
  {id:"755",n:"Rose Pink 755",f:"Rose Pink",hex:"#D26A72"},
  {id:"756",n:"Rose Pink 756",f:"Rose Pink",hex:"#CC515B"},
  {id:"757",n:"Rose Pink 757",f:"Rose Pink",hex:"#C63844"},
  {id:"758",n:"Rose Pink 758",f:"Rose Pink",hex:"#AF303B"},
  {id:"759",n:"Rose Pink 759",f:"Rose Pink",hex:"#982932"},
  {id:"761",n:"Biscuit Brown 761",f:"Biscuit Brown",hex:"#DAC8B3"},
  {id:"762",n:"Biscuit Brown 762",f:"Biscuit Brown",hex:"#CDB497"},
  {id:"763",n:"Biscuit Brown 763",f:"Biscuit Brown",hex:"#C1A07A"},
  {id:"764",n:"Biscuit Brown 764",f:"Biscuit Brown",hex:"#B58C5D"},
  {id:"765",n:"Biscuit Brown 765",f:"Biscuit Brown",hex:"#A27848"},
  {id:"766",n:"Biscuit Brown 766",f:"Biscuit Brown",hex:"#87633A"},
  {id:"767",n:"Biscuit Brown 767",f:"Biscuit Brown",hex:"#6B4E2D"},
  {id:"801",n:"Fuchsia 801",f:"Fuchsia",hex:"#E8A5C6"},
  {id:"802",n:"Fuchsia 802",f:"Fuchsia",hex:"#DE72A8"},
  {id:"803",n:"Fuchsia 803",f:"Fuchsia",hex:"#D53E89"},
  {id:"804",n:"Fuchsia 804",f:"Fuchsia",hex:"#B2236B"},
  {id:"805",n:"Fuchsia 805",f:"Fuchsia",hex:"#81174C"},
  {id:"821",n:"Royal Blue 821",f:"Royal Blue",hex:"#89A5E6"},
  {id:"822",n:"Royal Blue 822",f:"Royal Blue",hex:"#567FDE"},
  {id:"823",n:"Royal Blue 823",f:"Royal Blue",hex:"#255AD4"},
  {id:"824",n:"Royal Blue 824",f:"Royal Blue",hex:"#1A43A4"},
  {id:"825",n:"Royal Blue 825",f:"Royal Blue",hex:"#102E73"},
  {id:"831",n:"Bright Peacock Blue 831",f:"Bright Peacock Blue",hex:"#9ADEE9"},
  {id:"832",n:"Bright Peacock Blue 832",f:"Bright Peacock Blue",hex:"#63CFE0"},
  {id:"833",n:"Bright Peacock Blue 833",f:"Bright Peacock Blue",hex:"#2AC2D9"},
  {id:"834",n:"Bright Peacock Blue 834",f:"Bright Peacock Blue",hex:"#1B96A9"},
  {id:"835",n:"Bright Peacock Blue 835",f:"Bright Peacock Blue",hex:"#106673"},
  {id:"841",n:"Heraldic Gold 841",f:"Heraldic Gold",hex:"#EFDAA8"},
  {id:"842",n:"Heraldic Gold 842",f:"Heraldic Gold",hex:"#E8C46E"},
  {id:"843",n:"Heraldic Gold 843",f:"Heraldic Gold",hex:"#E4AF32"},
  {id:"844",n:"Heraldic Gold 844",f:"Heraldic Gold",hex:"#C18D14"},
  {id:"851",n:"Custard Yellow 851",f:"Custard Yellow",hex:"#E8DDA5"},
  {id:"852",n:"Navy Blue 852",f:"Navy Blue",hex:"#162759"},
  {id:"853",n:"Winchester Blue 853",f:"Winchester Blue",hex:"#698CAE"},
  {id:"854",n:"Dull Coral 854",f:"Dull Coral",hex:"#C48477"},
  {id:"855",n:"Dull Gold 855",f:"Dull Gold",hex:"#C9AC5E"},
  {id:"861",n:"Coral 861",f:"Coral",hex:"#ECBCB5"},
  {id:"862",n:"Coral 862",f:"Coral",hex:"#E59D92"},
  {id:"863",n:"Coral 863",f:"Coral",hex:"#DE7C6D"},
  {id:"864",n:"Coral 864",f:"Coral",hex:"#D85C48"},
  {id:"865",n:"Coral 865",f:"Coral",hex:"#CE3E28"},
  {id:"866",n:"Coral 866",f:"Coral",hex:"#AC321F"},
  {id:"871",n:"Pastel Shades A 871",f:"Pastel Shades A",hex:"#EBE5DF"},
  {id:"872",n:"Pastel Shades A 872",f:"Pastel Shades A",hex:"#E3D9D0"},
  {id:"873",n:"Pastel Shades A 873",f:"Pastel Shades A",hex:"#DACDC0"},
  {id:"874",n:"Pastel Shades A 874",f:"Pastel Shades A",hex:"#D2C1B1"},
  {id:"875",n:"Pastel Shades A 875",f:"Pastel Shades A",hex:"#CAB5A1"},
  {id:"876",n:"Pastel Shades A 876",f:"Pastel Shades A",hex:"#C1AA92"},
  {id:"877",n:"Pastel Shades A 877",f:"Pastel Shades A",hex:"#B99E82"},
  {id:"881",n:"Pastel Shades B 881",f:"Pastel Shades B",hex:"#DFE7EB"},
  {id:"882",n:"Pastel Shades B 882",f:"Pastel Shades B",hex:"#CEDAE0"},
  {id:"883",n:"Pastel Shades B 883",f:"Pastel Shades B",hex:"#BCCDD5"},
  {id:"884",n:"Pastel Shades B 884",f:"Pastel Shades B",hex:"#AAC0CB"},
  {id:"885",n:"Pastel Shades B 885",f:"Pastel Shades B",hex:"#98B3C0"},
  {id:"886",n:"Pastel Shades B 886",f:"Pastel Shades B",hex:"#85A6B6"},
  {id:"891",n:"Hyacinth 891",f:"Hyacinth",hex:"#D1BEE3"},
  {id:"892",n:"Hyacinth 892",f:"Hyacinth",hex:"#B79AD5"},
  {id:"893",n:"Hyacinth 893",f:"Hyacinth",hex:"#9E75C7"},
  {id:"894",n:"Hyacinth 894",f:"Hyacinth",hex:"#844FB9"},
  {id:"895",n:"Hyacinth 895",f:"Hyacinth",hex:"#6B3B9B"},
  {id:"896",n:"Hyacinth 896",f:"Hyacinth",hex:"#512C77"},
  {id:"901",n:"Golden Brown 901",f:"Golden Brown",hex:"#E1C298"},
  {id:"902",n:"Golden Brown 902",f:"Golden Brown",hex:"#D5A868"},
  {id:"903",n:"Golden Brown 903",f:"Golden Brown",hex:"#CB8E38"},
  {id:"904",n:"Golden Brown 904",f:"Golden Brown",hex:"#A26E27"},
  {id:"905",n:"Golden Brown 905",f:"Golden Brown",hex:"#744E1A"},
  {id:"911",n:"Fawn 911",f:"Fawn",hex:"#DED0C3"},
  {id:"912",n:"Fawn 912",f:"Fawn",hex:"#D0BAA6"},
  {id:"913",n:"Fawn 913",f:"Fawn",hex:"#C2A48A"},
  {id:"914",n:"Fawn 914",f:"Fawn",hex:"#B48E6C"},
  {id:"915",n:"Fawn 915",f:"Fawn",hex:"#A47851"},
  {id:"916",n:"Fawn 916",f:"Fawn",hex:"#896342"},
  {id:"921",n:"Dull China Blue 921",f:"Dull China Blue",hex:"#BCCEDB"},
  {id:"922",n:"Dull China Blue 922",f:"Dull China Blue",hex:"#A6BED0"},
  {id:"923",n:"Dull China Blue 923",f:"Dull China Blue",hex:"#90AFC5"},
  {id:"924",n:"Dull China Blue 924",f:"Dull China Blue",hex:"#7A9FBA"},
  {id:"925",n:"Dull China Blue 925",f:"Dull China Blue",hex:"#6390AF"},
  {id:"926",n:"Dull China Blue 926",f:"Dull China Blue",hex:"#517FA0"},
  {id:"927",n:"Dull China Blue 927",f:"Dull China Blue",hex:"#456E8B"},
  {id:"928",n:"Dull China Blue 928",f:"Dull China Blue",hex:"#3A5C75"},
  {id:"929",n:"Dull China Blue 929",f:"Dull China Blue",hex:"#2E4B60"},
  {id:"931",n:"Dull Mauve 931",f:"Dull Mauve",hex:"#D4B8CD"},
  {id:"932",n:"Dull Mauve 932",f:"Dull Mauve",hex:"#C196B6"},
  {id:"933",n:"Dull Mauve 933",f:"Dull Mauve",hex:"#AE73A0"},
  {id:"934",n:"Dull Mauve 934",f:"Dull Mauve",hex:"#975587"},
  {id:"935",n:"Dull Mauve 935",f:"Dull Mauve",hex:"#764168"},
  {id:"941",n:"Bright Rose Pink 941",f:"Bright Rose Pink",hex:"#F0C5CE"},
  {id:"942",n:"Bright Rose Pink 942",f:"Bright Rose Pink",hex:"#EAA8B5"},
  {id:"943",n:"Bright Rose Pink 943",f:"Bright Rose Pink",hex:"#E4899B"},
  {id:"944",n:"Bright Rose Pink 944",f:"Bright Rose Pink",hex:"#DE6A82"},
  {id:"945",n:"Bright Rose Pink 945",f:"Bright Rose Pink",hex:"#D94B68"},
  {id:"946",n:"Bright Rose Pink 946",f:"Bright Rose Pink",hex:"#D42C4D"},
  {id:"947",n:"Bright Rose Pink 947",f:"Bright Rose Pink",hex:"#B82341"},
  {id:"948",n:"Bright Rose Pink 948",f:"Bright Rose Pink",hex:"#9B1C35"},
  {id:"951",n:"Drab Fawn 951",f:"Drab Fawn",hex:"#D4C9B8"},
  {id:"952",n:"Drab Fawn 952",f:"Drab Fawn",hex:"#C6B69F"},
  {id:"953",n:"Drab Fawn 953",f:"Drab Fawn",hex:"#B8A386"},
  {id:"954",n:"Drab Fawn 954",f:"Drab Fawn",hex:"#AB916D"},
  {id:"955",n:"Drab Fawn 955",f:"Drab Fawn",hex:"#997E57"},
  {id:"956",n:"Drab Fawn 956",f:"Drab Fawn",hex:"#816948"},
  {id:"957",n:"Drab Fawn 957",f:"Drab Fawn",hex:"#69553A"},
  {id:"961",n:"Iron Grey 961",f:"Iron Grey",hex:"#C2C5CB"},
  {id:"962",n:"Iron Grey 962",f:"Iron Grey",hex:"#ACB0B8"},
  {id:"963",n:"Iron Grey 963",f:"Iron Grey",hex:"#969BA6"},
  {id:"964",n:"Iron Grey 964",f:"Iron Grey",hex:"#7F8693"},
  {id:"965",n:"Iron Grey 965",f:"Iron Grey",hex:"#6B717F"},
  {id:"966",n:"Iron Grey 966",f:"Iron Grey",hex:"#585E69"},
  {id:"967",n:"Iron Grey 967",f:"Iron Grey",hex:"#454A53"},
  {id:"968",n:"Iron Grey 968",f:"Iron Grey",hex:"#32363D"},
  {id:"971",n:"Elephant Grey 971",f:"Elephant Grey",hex:"#C0BCB8"},
  {id:"972",n:"Elephant Grey 972",f:"Elephant Grey",hex:"#A9A49E"},
  {id:"973",n:"Elephant Grey 973",f:"Elephant Grey",hex:"#938B84"},
  {id:"974",n:"Elephant Grey 974",f:"Elephant Grey",hex:"#7A736B"},
  {id:"975",n:"Elephant Grey 975",f:"Elephant Grey",hex:"#605A54"},
  {id:"976",n:"Elephant Grey 976",f:"Elephant Grey",hex:"#46423D"},
  {id:"981",n:"Putty Groundings 981",f:"Putty Groundings",hex:"#D9D3C8"},
  {id:"982",n:"Putty Groundings 982",f:"Putty Groundings",hex:"#CDC5B6"},
  {id:"983",n:"Putty Groundings 983",f:"Putty Groundings",hex:"#C0B7A4"},
  {id:"984",n:"Putty Groundings 984",f:"Putty Groundings",hex:"#B4A991"},
  {id:"985",n:"Putty Groundings 985",f:"Putty Groundings",hex:"#A89A7F"},
  {id:"986",n:"Putty Groundings 986",f:"Putty Groundings",hex:"#9C8C6C"},
  {id:"987",n:"Putty Groundings 987",f:"Putty Groundings",hex:"#8C7D5D"},
  {id:"988",n:"Putty Groundings 988",f:"Putty Groundings",hex:"#7A6C51"},
  {id:"989",n:"Putty Groundings 989",f:"Putty Groundings",hex:"#685C44"},
  {id:"991b",n:"Bright White 991b",f:"Bright White",hex:"#FCFCFC"},
  {id:"991",n:"White 991",f:"White",hex:"#F5F4F4"},
  {id:"992",n:"Off White 992",f:"Off White",hex:"#EBEBE9"},
  {id:"994",n:"Rust 994",f:"Rust",hex:"#B04F25"},
  {id:"995",n:"Cherry Red 995",f:"Cherry Red",hex:"#C81C39"},
  {id:"996",n:"Lemon 996",f:"Lemon",hex:"#F4ECA3"},
  {id:"997",n:"Lime 997",f:"Lime",hex:"#B4E15A"},
  {id:"998",n:"Charcoal 998",f:"Charcoal",hex:"#2F3136"},
];

type Raw = { id: string; n: string; f: string; hex: string };
type Rgb = [number, number, number];
type Shading = "none" | "light" | "medium" | "heavy";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function dist(a: number[], b: number[]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b);
  let x = rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375;
  let y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750;
  let z = rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041;
  x /= 0.95047; y /= 1.0; z /= 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDistSq(a: [number, number, number], b: [number, number, number]): number {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}


// A cluster colour carries its sample population so merges can weight by it.
type ClusterColour = { rgb: Rgb; population: number; protected?: boolean };

// Same principle boxRepresentativeColour already relies on (median-cut box
// summarisation): averaging two colours in raw RGB only makes sense when
// they are noise either side of ONE true colour. Force two perceptually
// DISTANT colours together and the average is a hue that exists nowhere in
// the source -- a phantom. enforceColourCeiling below has no choice but to
// keep merging until it hits the user's requested ceiling, so under a tight
// budget it eventually has nothing left to merge but genuinely unrelated
// colours (a green pea pod, a pink radish, off-white paper). Measured on a
// real upload: DMC matched the resulting phantom to 3042 Antique Violet Lt
// -- a lilac thread nowhere in the source image -- while the real green
// content had no thread at all. Same root cause and same fix as the
// existing box-fusion guard, just applied at the stage that was actually
// inventing the colour.
const CEILING_FUSION_DE = 25;

function weightedMergePair(a: ClusterColour, b: ClusterColour): ClusterColour {
  const wa = Math.max(1, a.population);
  const wb = Math.max(1, b.population);
  const total = wa + wb;
  const isProtected = a.protected || b.protected;
  const dE = ciede2000(rgbToLab(a.rgb[0], a.rgb[1], a.rgb[2]), rgbToLab(b.rgb[0], b.rgb[1], b.rgb[2]));
  if (dE > CEILING_FUSION_DE) {
    const dominant = wa >= wb ? a : b;
    return { rgb: [...dominant.rgb] as Rgb, population: a.population + b.population, protected: isProtected };
  }
  return {
    rgb: [
      Math.round((a.rgb[0] * wa + b.rgb[0] * wb) / total),
      Math.round((a.rgb[1] * wa + b.rgb[1] * wb) / total),
      Math.round((a.rgb[2] * wa + b.rgb[2] * wb) / total),
    ],
    population: a.population + b.population,
    protected: isProtected,
  };
}

// Population-ratio gate: a small, isolated cluster (e.g. a thin feature like
// a lime wedge) sitting close in Lab space to a much larger dominant cluster
// (e.g. surrounding liquid) must NOT be swallowed by it purely because the
// colours are perceptually similar. We only let a lopsided merge through when
// the two colours are near-identical (a true duplicate, e.g. background white
// absorbing a stray near-white cluster) — that always merges regardless of
// population skew. Values picked from simulation against realistic raw-cluster
// populations: 8x is comfortably below the ~30:1 ratio that was erasing real
// small features, comfortably above normal same-surface population variance
// (e.g. navy rim vs navy stem, ~2:1).
const MERGE_RATIO_GATE = 8;
const MERGE_NEAR_IDENTICAL_FRACTION = 0.25;
// Spatial-coherence gate: a raw cluster that forms a real, spatially compact
// patch (not scattered noise) — e.g. a highlight stripe, a shadow swoosh —
// shouldn't be folded into a Lab-close neighbour just because the colours
// are similar. Floor picked from real largestComponent measurements this
// session: genuine surface clusters on a clean flat image measured ~10-126,
// noise/antialiasing fragments measured ~2-9.
const SPATIAL_PROTECT_MIN_COMPONENT = 8;

function mergeSimilarClusters(
  colours: ClusterColour[],
  threshold: number,
  rawSpatial?: Array<{ largestComponent: number }>,
): ClusterColour[] {
  if (threshold <= 0 || colours.length < 2) return colours.map(c => ({ rgb: [...c.rgb] as Rgb, population: c.population, protected: c.protected }));
  const remaining: ClusterColour[] = colours.map(c => ({ rgb: [...c.rgb] as Rgb, population: c.population, protected: c.protected }));
  let labs: [number, number, number][] = remaining.map(c => rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));
  // Lineage tracking: which original raw-cluster rgb/population/spatial
  // entries fed into each surviving merged entry. Logged at the end for
  // diagnostics, and also used live below to compute each evolving cluster's
  // spatial-compactness (max largestComponent among its contributors) for
  // the spatial-coherence gate — does NOT otherwise affect bestI/bestJ
  // selection, threshold, or the ratio gate.
  let lineage: Array<Array<{ rgb: Rgb; population: number; largestComponent: number }>> =
    colours.map((c, i) => [{ rgb: c.rgb, population: c.population, largestComponent: rawSpatial?.[i]?.largestComponent ?? 0 }]);
  const blockedByRatio: Array<{ popA: number; popB: number; labDistSq: number; ratio: number }> = [];
  const blockedBySpatial: Array<{ popA: number; popB: number; labDistSq: number; spatialA: number; spatialB: number }> = [];
  while (remaining.length > 1) {
    let bestI = -1, bestJ = -1, bestD = Infinity;
    let blockedThisRound: { popA: number; popB: number; labDistSq: number; ratio: number } | null = null;
    let blockedSpatialThisRound: { popA: number; popB: number; labDistSq: number; spatialA: number; spatialB: number } | null = null;
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        const d = labDistSq(labs[i], labs[j]);
        if (d >= threshold) continue;
        const popA = remaining[i].population, popB = remaining[j].population;
        const ratio = Math.max(popA, popB) / Math.max(1, Math.min(popA, popB));
        const nearIdentical = d <= threshold * MERGE_NEAR_IDENTICAL_FRACTION;
        if (ratio > MERGE_RATIO_GATE && !nearIdentical) {
          if (!blockedThisRound || ratio > blockedThisRound.ratio) {
            blockedThisRound = { popA, popB, labDistSq: Math.round(d), ratio: Math.round(ratio * 10) / 10 };
          }
          continue;
        }
        const spatialA = Math.max(0, ...lineage[i].map(e => e.largestComponent));
        const spatialB = Math.max(0, ...lineage[j].map(e => e.largestComponent));
        if (!nearIdentical && spatialA >= SPATIAL_PROTECT_MIN_COMPONENT && spatialB >= SPATIAL_PROTECT_MIN_COMPONENT) {
          if (!blockedSpatialThisRound || Math.min(spatialA, spatialB) > Math.min(blockedSpatialThisRound.spatialA, blockedSpatialThisRound.spatialB)) {
            blockedSpatialThisRound = { popA, popB, labDistSq: Math.round(d), spatialA, spatialB };
          }
          continue;
        }
        if (d < bestD) { bestD = d; bestI = i; bestJ = j; }
      }
    }
    if (bestI < 0) {
      if (blockedThisRound) blockedByRatio.push(blockedThisRound);
      if (blockedSpatialThisRound) blockedBySpatial.push(blockedSpatialThisRound);
      break;
    }
    const merged = weightedMergePair(remaining[bestI], remaining[bestJ]);
    const mergedLineage = lineage[bestJ].concat(lineage[bestI]);
    remaining.splice(bestJ, 1);
    remaining.splice(bestI, 1);
    remaining.push(merged);
    lineage.splice(bestJ, 1);
    lineage.splice(bestI, 1);
    lineage.push(mergedLineage);
    labs = remaining.map(c => rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));
  }
  if (blockedByRatio.length) {
    console.log("mergeSimilarClusters blockedByRatio", blockedByRatio);
  }
  if (blockedBySpatial.length) {
    console.log("mergeSimilarClusters blockedBySpatial", blockedBySpatial);
  }
  console.log("mergeSimilarClusters lineage", remaining.map((c, i) => ({
    finalRgb: c.rgb,
    finalPopulation: c.population,
    contributingRawClusters: lineage[i],
  })));
  return remaining;
}

function enforceColourCeiling(colours: ClusterColour[], ceiling: number): ClusterColour[] {
  if (colours.length <= ceiling) return colours.map(c => ({ rgb: [...c.rgb] as Rgb, population: c.population, protected: c.protected }));
  const remaining: ClusterColour[] = colours.map(c => ({ rgb: [...c.rgb] as Rgb, population: c.population, protected: c.protected }));
  let labs = remaining.map(c => rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));
  while (remaining.length > ceiling) {
    // A reserved vivid/dark-neutral cluster (see reserveVividColours /
    // reserveDarkNeutrals) must survive this reduction whenever the ceiling
    // leaves room, the same guarantee near-white already has through the
    // later palette-merge passes. Once only protected entries stand between
    // remaining.length and ceiling, there is no room left to avoid them --
    // the ceiling is a hard cap the user explicitly set, so it is still
    // honoured, just as a last resort rather than a first one.
    const protectedCount = remaining.filter(c => c.protected).length;
    const mustTouchProtected = remaining.length - protectedCount <= ceiling;
    let bestI = -1, bestJ = -1, bestScore = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        if (!mustTouchProtected && (remaining[i].protected || remaining[j].protected)) continue;
        const d = labDistSq(labs[i], labs[j]);
        const popA = remaining[i].population, popB = remaining[j].population;
        const ratio = Math.max(popA, popB) / Math.max(1, Math.min(popA, popB));
        // Soft penalty only — the ceiling is a hard cap so we must always
        // complete the reduction, but we bias toward merging similarly-sized
        // clusters over crushing a small distinct one into a giant one.
        const score = d * (1 + Math.log2(Math.min(ratio, 64)));
        if (score < bestScore) { bestScore = score; bestI = i; bestJ = j; }
      }
    }
    if (bestI < 0) break; // every remaining pair protected and not forced -- stop rather than loop
    const merged = weightedMergePair(remaining[bestI], remaining[bestJ]);
    remaining.splice(bestJ, 1);
    remaining.splice(bestI, 1);
    remaining.push(merged);
    labs.splice(bestJ, 1);
    labs.splice(bestI, 1);
    labs.push(rgbToLab(merged.rgb[0], merged.rgb[1], merged.rgb[2]));
  }
  console.log("enforceColourCeiling:", JSON.stringify({
    ceiling, kept: remaining.length,
    protectedSurvived: remaining.filter(c => c.protected).length,
  }));
  return remaining;
}


// Cache Lab conversions per palette array so we don't re-convert on every
// nearest-colour lookup. WeakMap key = the Rgb[] array reference.
const labCache = new WeakMap<Rgb[], [number, number, number][]>();
function getLabs(colours: Rgb[]): [number, number, number][] {
  let lab = labCache.get(colours);
  if (!lab) {
    lab = colours.map((c) => rgbToLab(c[0], c[1], c[2]));
    labCache.set(colours, lab);
  }
  return lab;
}

function nearestRgbIndex(rgb: Rgb, colours: Rgb[]): number {
  const labs = getLabs(colours);
  const target = rgbToLab(rgb[0], rgb[1], rgb[2]);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < labs.length; i++) {
    const d = labDistSq(target, labs[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Chroma of a Lab colour -- how far it is from neutral grey. */
function labChroma(l: [number, number, number]): number {
  return Math.sqrt(l[1] * l[1] + l[2] * l[2]);
}
/** Hue angle in degrees. */
function labHue(l: [number, number, number]): number {
  const d = Math.atan2(l[2], l[1]) * 180 / Math.PI;
  return d < 0 ? d + 360 : d;
}
/** Smallest absolute angle between two hues, 0..180. */
function hueDelta(a: number, b: number): number {
  return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
}

/**
 * Perceptual weights for thread matching. Plain Euclidean Lab treats a hue
 * error and a lightness error as equally costly; for needlepoint they are not.
 * A slightly-too-light green still reads as green fabric. A grey does not.
 */
const THREAD_HUE_WEIGHT = 2.8;
const THREAD_CHROMA_WEIGHT = 0.7;
/** Below this source chroma there is no meaningful hue to preserve. */
const THREAD_HUE_RAMP_START = 2;
/** ...and by this chroma the hue weight is applied in full. */
const THREAD_HUE_RAMP_END = 8;

/**
 * Distance between a source colour and a candidate thread, in cylindrical Lab
 * (lightness / chroma / hue) so each axis can carry its own weight.
 *
 * The hue weight ramps in with the SOURCE's chroma: a near-neutral source has
 * no real hue, so weighting its hue error would push greys toward arbitrary
 * colours. A hard chroma cutoff was tried first and is why flat fabric came out
 * speckled -- pixels either side of the cutoff went to different colour
 * families. A ramp has no cliff, so neighbouring pixels always resolve
 * consistently.
 */
function weightedThreadDistance(src: [number, number, number], thread: [number, number, number]): number {
  const dL = src[0] - thread[0];
  const srcC = Math.sqrt(src[1] * src[1] + src[2] * src[2]);
  const thrC = Math.sqrt(thread[1] * thread[1] + thread[2] * thread[2]);
  const dC = srcC - thrC;
  const srcH = Math.atan2(src[2], src[1]);
  const thrH = Math.atan2(thread[2], thread[1]);
  let dh = srcH - thrH;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  // Chord length of the hue difference, scaled by how colourful both are.
  const dH = 2 * Math.sqrt(Math.max(srcC * thrC, 0)) * Math.sin(dh / 2);
  const ramp = Math.min(1, Math.max(0, (srcC - THREAD_HUE_RAMP_START) / (THREAD_HUE_RAMP_END - THREAD_HUE_RAMP_START)));
  const hueW = 1 + (THREAD_HUE_WEIGHT - 1) * ramp;
  return dL * dL + Math.pow(THREAD_CHROMA_WEIGHT * dC, 2) + Math.pow(hueW * dH, 2);
}

/**
 * Appletons (and DMC) ship as colour CARDS -- families of ~7-9 shades running
 * light to dark at a consistent hue. Matching each cluster independently
 * against all 420 threads throws that structure away and lets lightness
 * outvote hue, which is how a green fabric ends up stitched in greys.
 *
 * So: choose the FAMILY by hue, then the SHADE within it by lightness.
 */
interface ThreadFamily { name: string; idx: number[]; meanHue: number | null; meanChroma: number }
let familyCache: { key: number; fams: ThreadFamily[] } | null = null;

function buildFamilies(palette: Raw[], palRgb: Rgb[]): ThreadFamily[] {
  if (familyCache && familyCache.key === palette.length) return familyCache.fams;
  const byName = new Map<string, number[]>();
  for (let i = 0; i < palette.length; i++) {
    const f = palette[i].f ?? "Other";
    const list = byName.get(f);
    if (list) list.push(i); else byName.set(f, [i]);
  }
  const fams: ThreadFamily[] = [];
  for (const [name, idx] of byName) {
    let x = 0, y = 0, cSum = 0, n = 0;
    for (const i of idx) {
      const l = rgbToLab(palRgb[i][0], palRgb[i][1], palRgb[i][2]);
      const c = Math.sqrt(l[1] * l[1] + l[2] * l[2]);
      cSum += c;
      if (c > 3) { const h = Math.atan2(l[2], l[1]); x += Math.cos(h); y += Math.sin(h); n++; }
    }
    fams.push({
      name, idx,
      meanHue: n > 0 ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : null,
      meanChroma: cSum / idx.length,
    });
  }
  familyCache = { key: palette.length, fams };
  return fams;
}

/**
 * Family-aware thread choice. `used` carries threads already claimed, so a
 * second cluster of the same colour takes the NEXT shade of the same card
 * rather than duplicating -- which is where tonal range comes from.
 */
function pickThreadInFamily(
  rgb: Rgb, palette: Raw[], palRgb: Rgb[], used: Set<number>,
): number {
  const fams = buildFamilies(palette, palRgb);
  const sl = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const sc = Math.sqrt(sl[1] * sl[1] + sl[2] * sl[2]);
  const sh = (Math.atan2(sl[2], sl[1]) * 180 / Math.PI + 360) % 360;
  let best: ThreadFamily | null = null, bestScore = Infinity;
  for (const f of fams) {
    let score: number;
    if (sc < 3.5) {
      // Genuinely neutral source -- only a neutral family can serve it.
      if (f.meanChroma > 8) continue;
      score = Math.abs(f.meanChroma - sc) * 2;
    } else {
      if (f.meanHue === null) continue;
      const dh = Math.abs(((sh - f.meanHue + 180) % 360 + 360) % 360 - 180);
      score = dh + Math.abs(f.meanChroma - sc) * 0.35;
    }
    // Penalise a family that cannot reach this lightness at all.
    let lo = Infinity, hi = -Infinity;
    for (const i of f.idx) {
      const L = rgbToLab(palRgb[i][0], palRgb[i][1], palRgb[i][2])[0];
      if (L < lo) lo = L;
      if (L > hi) hi = L;
    }
    if (sl[0] < lo - 14 || sl[0] > hi + 14) score += 25;
    if (score < bestScore) { bestScore = score; best = f; }
  }
  if (!best) return nearestPaletteIndex(rgb, palRgb);
  const shadeCost = (i: number): number => {
    const l = rgbToLab(palRgb[i][0], palRgb[i][1], palRgb[i][2]);
    const c = Math.sqrt(l[1] * l[1] + l[2] * l[2]);
    return (l[0] - sl[0]) * (l[0] - sl[0]) + 0.25 * (c - sc) * (c - sc);
  };
  const unused = best.idx.filter((i) => !used.has(i));
  const pool = unused.length ? unused : best.idx;
  let pick = pool[0];
  let pickCost = Infinity;
  for (const i of pool) { const c = shadeCost(i); if (c < pickCost) { pickCost = c; pick = i; } }
  return pick;
}

function nearestPaletteIndex(rgb: Rgb, palRgb: Rgb[], exclude?: Set<number>): number {
  const labs = getLabs(palRgb);
  const target = rgbToLab(rgb[0], rgb[1], rgb[2]);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < labs.length; i++) {
    if (exclude?.has(i)) continue;
    const d = weightedThreadDistance(target, labs[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best >= 0 ? best : nearestRgbIndex(rgb, palRgb);
}

// averageColour / channelWithLargestRange / medianCut / isPlainWhite /
// buildClusterColours / medianDenoise / computeFlatRegionMask now live in
// ./palette-derivation.ts (imported at the top of this file).



// Detects thin linear feature pixels in a full-resolution source image.
// Returns a Uint8Array where 1 = thin line pixel, 0 = normal pixel.
// Uses a simple cross-pattern contrast check: a pixel is a thin line pixel
// if it contrasts strongly with its horizontal OR vertical neighbours,
// but those neighbours contrast with EACH OTHER (i.e. the pixel is sandwiched).
function detectThinLinePixels(
  srcRgb: Uint8Array,
  srcW: number,
  srcH: number,
  contrastThreshold: number = 40
): Uint8Array {
  const result = new Uint8Array(srcW * srcH);
  for (let y = 1; y < srcH - 1; y++) {
    for (let x = 1; x < srcW - 1; x++) {
      const i = y * srcW + x;
      const off = i * 3;
      const r = srcRgb[off], g = srcRgb[off+1], b = srcRgb[off+2];

      const lOff = (y * srcW + (x-1)) * 3;
      const rOff = (y * srcW + (x+1)) * 3;
      const tOff = ((y-1) * srcW + x) * 3;
      const bOff = ((y+1) * srcW + x) * 3;

      const lDiff = Math.abs(r - srcRgb[lOff]) + Math.abs(g - srcRgb[lOff+1]) + Math.abs(b - srcRgb[lOff+2]);
      const rDiff = Math.abs(r - srcRgb[rOff]) + Math.abs(g - srcRgb[rOff+1]) + Math.abs(b - srcRgb[rOff+2]);
      const tDiff = Math.abs(r - srcRgb[tOff]) + Math.abs(g - srcRgb[tOff+1]) + Math.abs(b - srcRgb[tOff+2]);
      const bDiff = Math.abs(r - srcRgb[bOff]) + Math.abs(g - srcRgb[bOff+1]) + Math.abs(b - srcRgb[bOff+2]);

      const hThin = lDiff > contrastThreshold && rDiff > contrastThreshold;
      const vThin = tDiff > contrastThreshold && bDiff > contrastThreshold;

      if (hThin || vThin) result[i] = 1;
    }
  }
  return result;
}

// Detects coherent thin line segments in the full-resolution source image
// by running 8-connected flood fill on the thinLineMap bitmap, then maps
// each component's pixel positions to output grid cell indices.
// Returns one entry per segment with the segment's dominant colour (mode RGB
// among its thin pixels) and the set of output grid cell indices it covers.
// Minimum component size is scale-relative — see detectLineSegments body.

function detectLineSegments(
  srcPixelRgb: Uint8Array,
  srcW: number,
  srcH: number,
  thinLineMap: Uint8Array,
  gridW: number,
  gridH: number,
  rw: number,
  rh: number,
  ox: number,
  oy: number,
): Array<{ colour: [number, number, number]; outputCells: Set<number> }> {
  const visited = new Uint8Array(srcW * srcH);
  const segments: Array<{ colour: [number, number, number]; outputCells: Set<number> }> = [];

  for (let startY = 0; startY < srcH; startY++) {
    for (let startX = 0; startX < srcW; startX++) {
      const startIdx = startY * srcW + startX;
      if (!thinLineMap[startIdx] || visited[startIdx]) continue;

      // BFS flood fill on thin-line pixels
      const pixels: Array<[number, number]> = [];
      const queue: number[] = [startIdx];
      visited[startIdx] = 1;
      while (queue.length) {
        const idx = queue.pop()!;
        const py = (idx / srcW) | 0;
        const px = idx % srcW;
        pixels.push([px, py]);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny = py + dy, nx = px + dx;
            if (ny < 0 || ny >= srcH || nx < 0 || nx >= srcW) continue;
            const ni = ny * srcW + nx;
            if (!thinLineMap[ni] || visited[ni]) continue;
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }

      if (pixels.length < Math.max(6, Math.round(1.4 * (srcW / gridW)))) continue;

      // Elongation check: genuine line features (glazing bars, door
      // surrounds, pith lines) are long and thin. Noise blobs (antialiasing
      // fringe, shadow patches) are roughly blob-shaped. Compute the
      // bounding box and require the longer dimension to be at least 2.5x
      // the shorter dimension, OR the pixel count to be much smaller than
      // the bounding box area (sparse/diagonal lines don't fill their box).
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [px, py] of pixels) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;
      const longSide = Math.max(bboxW, bboxH);
      const shortSide = Math.max(1, Math.min(bboxW, bboxH));
      const aspectRatio = longSide / shortSide;
      const bboxArea = bboxW * bboxH;
      const fillRatio = pixels.length / bboxArea;
      // Require BOTH a minimum pixel count scaled to bounding box AND either
      // strong elongation or low fill ratio. This excludes thin diagonal
      // noise slivers (1px wide, technically "elongated" by aspect ratio
      // but only 2-3px total) while still allowing short curved pith runs
      // (low fill ratio because they curve outside a tight bbox).
      // Hard bounding-box cap: a genuine thin line feature (glazing bar,
      // door surround, pith arc) spans a small fraction of the source image
      // — it's a 1-2 output-cell-wide stroke, not an object-sized region.
      // A component whose bounding box exceeds ~8% of the source image in
      // EITHER dimension is an ordinary shape edge or shading gradient that
      // happened to pass the contrast/elongation checks, not a fine line.
      // (Real-world evidence: legitimate glazing bar/pith components in
      // passing runs measured well under this; the false positives causing
      // stray stitches in the bowl/stem/lime measured 100-131px bboxes
      // against a ~1024px source — i.e. ~10-13% — while genuine thin
      // features measured under 45px, ~4%.)
      const MAX_SEGMENT_BBOX_FRACTION = 0.06;
      const oversizedBbox =
        bboxW > srcW * MAX_SEGMENT_BBOX_FRACTION || bboxH > srcH * MAX_SEGMENT_BBOX_FRACTION;
      if (oversizedBbox) {
        // A long object OUTLINE is thin but large-bounding-box: it wraps the
        // subject, so it fails the size test while being exactly the kind of
        // feature this detector exists to protect. Distinguish by actual
        // stroke width (area / length), which stays small however long the
        // stroke runs, rather than by extent. The original size gate is kept
        // for everything else -- it was added against real false positives
        // (stray stitches in a bowl/stem/lime, 100-131px bboxes).
        const longSideExtent = Math.max(bboxW, bboxH);
        const strokeWidthPx = pixels.length / Math.max(1, longSideExtent);
        const pxPerCellHere = srcW / gridW;
        const isThinStroke = strokeWidthPx <= 1.2 * pxPerCellHere;
        if (!isThinStroke) continue;
      }

      // Scale-relative minimum: ~1.4 cell-lengths of source pixels. At the
      // default 1024px→78 cells (≈13.1 px/cell) this equals the previously
      // tuned 18; at other canvas sizes / mesh counts it scales with the
      // source-to-grid ratio instead of silently becoming too strict or too
      // loose (technical plan §5.1, resolution generalisation).
      const pxPerCell = srcW / gridW;
      const minSegmentPixels = Math.max(6, Math.round(1.4 * pxPerCell));
      const isElongated = (aspectRatio >= 3.0 || fillRatio <= 0.35) && pixels.length >= minSegmentPixels;
      if (!isElongated) continue;


      // Skeletonize this component to its 1-pixel-wide medial axis BEFORE
      // mapping to grid cells. A thick source bar (e.g. 1.5 output-cells wide)
      // otherwise stamps two columns of cells, producing wonky/two-wide/
      // asymmetric output. The skeleton is a single centerline, so it maps to
      // exactly one cell-wide stroke. Junctions (window crosses, T-joins) are
      // preserved because we stamp every skeleton pixel's cell rather than
      // stroking endpoint-to-endpoint.

      // Build a tight local bitmap of this component for thinning.
      const compW = bboxW + 2; // 1px padding each side
      const compH = bboxH + 2;
      const baseX = minX - 1;
      const baseY = minY - 1;
      let bmp = new Uint8Array(compW * compH);
      for (const [px, py] of pixels) {
        bmp[(py - baseY) * compW + (px - baseX)] = 1;
      }

      // Zhang-Suen thinning: iteratively removes boundary pixels until only
      // a 1-pixel-wide skeleton remains, preserving connectivity and topology.
      // Allocation-free inner loop: neighbour values read inline, transition
      // count computed without building arrays, so this stays within the
      // Edge Function CPU budget even across many components.
      const toRemove: number[] = [];
      let changed = true;
      let guard = 0;
      while (changed && guard < 100) {
        changed = false;
        guard++;
        for (let step = 0; step < 2; step++) {
          toRemove.length = 0;
          for (let y = 1; y < compH - 1; y++) {
            const rowBase = y * compW;
            for (let x = 1; x < compW - 1; x++) {
              const ci = rowBase + x;
              if (bmp[ci] !== 1) continue;
              // P2..P9 clockwise from North
              const p2 = bmp[ci - compW];      // N
              const p3 = bmp[ci - compW + 1];  // NE
              const p4 = bmp[ci + 1];          // E
              const p5 = bmp[ci + compW + 1];  // SE
              const p6 = bmp[ci + compW];      // S
              const p7 = bmp[ci + compW - 1];  // SW
              const p8 = bmp[ci - 1];          // W
              const p9 = bmp[ci - compW - 1];  // NW
              const bp = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
              if (bp < 2 || bp > 6) continue;
              // transition count A(P1): 0->1 transitions in ordered sequence
              let a = 0;
              if (p2 === 0 && p3 === 1) a++;
              if (p3 === 0 && p4 === 1) a++;
              if (p4 === 0 && p5 === 1) a++;
              if (p5 === 0 && p6 === 1) a++;
              if (p6 === 0 && p7 === 1) a++;
              if (p7 === 0 && p8 === 1) a++;
              if (p8 === 0 && p9 === 1) a++;
              if (p9 === 0 && p2 === 1) a++;
              if (a !== 1) continue;
              if (step === 0) {
                if (p2 * p4 * p6 !== 0) continue; // N*E*S
                if (p4 * p6 * p8 !== 0) continue; // E*S*W
              } else {
                if (p2 * p4 * p8 !== 0) continue; // N*E*W
                if (p2 * p6 * p8 !== 0) continue; // N*S*W
              }
              toRemove.push(ci);
            }
          }
          if (toRemove.length) {
            changed = true;
            for (let i = 0; i < toRemove.length; i++) bmp[toRemove[i]] = 0;
          }
        }
      }

      if (guard >= 100) {
        console.log("skeleton thinning HIT GUARD LIMIT for component at", { minX, minY, bboxW, bboxH, pixelCount: pixels.length });
      }
      // Repair junction erosion BEFORE mapping: Zhang-Suen deletes the
      // centre of "+" crossings, leaving four disconnected arms. Reconnect
      // endpoints across the void so the mapped skeleton is a connected
      // cross, not four stubs. This fixes the missing-chunk-in-crossing-bar
      // defect at its true source.
      const bridged = repairJunctionErosion(bmp, compW, compH, 3);
      if (bridged > 0) console.log("junction erosion repaired:", bridged, "bridge px");

      // Mode colour, sampled from the MEDIAL AXIS (the thinned skeleton in
      // `bmp`), not from the raw thin-line component.
      //
      // detectThinLinePixels flags a pixel only when both opposite neighbours
      // differ sharply from it. On a stroke wider than one pixel that holds at
      // the stroke's EDGES and not through its core, because the core's
      // neighbours are the same ink. The edges of black ink on white paper are
      // the anti-aliased blend, so tallying the component's pixels returns a
      // mid-tone -- measured live, black handwriting produced [184,185,169],
      // a beige that appears nowhere in the artwork, and the darkest segment
      // colour in the whole run was pixSum 394. Everything downstream then
      // faithfully carried that wrong colour.
      //
      // The skeleton is by definition the centreline of the stroke, so its
      // pixels are ink rather than halo. This is direction-agnostic: it is
      // equally correct for a pale line on a dark ground, so cream glazing
      // bars and pith arcs keep working.
      // Ink colour = mode of the stroke's DARKEST-CONTRAST quarter, not the
      // mode of all its pixels. detectThinLinePixels flags stroke EDGES, not
      // the core, so tallying the component returns anti-aliased halo: black
      // handwriting reported [125,124,124] and stamped grey. Ranking pixels
      // by distance from the measured local ground and taking the extreme
      // quarter isolates the ink ridge. Measured on real artwork, text block:
      // median pixel sum 500 -> 117, segments reading as ink 45% -> 100%.
      // Direction-agnostic: a pale line on a dark field yields its own pale
      // extreme, so cream glazing bars and pith arcs are unaffected.
      const ringTally = new Map<string, number>();
      for (let y = -1; y <= compH; y++) {
        for (let x = -1; x <= compW; x++) {
          const srcPx = x + baseX, srcPy = y + baseY;
          if (srcPx < 0 || srcPy < 0 || srcPx >= srcW || srcPy >= srcH) continue;
          if (y >= 0 && y < compH && x >= 0 && x < compW && bmp[y * compW + x] === 1) continue;
          const off = (srcPy * srcW + srcPx) * 3;
          const key = `${srcPixelRgb[off] >> 4},${srcPixelRgb[off + 1] >> 4},${srcPixelRgb[off + 2] >> 4}`;
          ringTally.set(key, (ringTally.get(key) ?? 0) + 1);
        }
      }
      let groundSum = 384;
      let groundBest = 0;
      for (const [k, n] of ringTally) {
        if (n <= groundBest) continue;
        groundBest = n;
        const parts = k.split(",");
        groundSum = (Number(parts[0]) + Number(parts[1]) + Number(parts[2])) * 16 + 24;
      }
      const inkPixels: { r: number; g: number; b: number; d: number }[] = [];
      for (const [px, py] of pixels) {
        const off = (py * srcW + px) * 3;
        const r = srcPixelRgb[off], g = srcPixelRgb[off + 1], b = srcPixelRgb[off + 2];
        inkPixels.push({ r, g, b, d: Math.abs(r + g + b - groundSum) });
      }
      inkPixels.sort((p, q) => q.d - p.d);
      const keepCount = Math.max(1, Math.ceil(inkPixels.length * 0.25));
      const colourTally = new Map<string, { count: number; r: number; g: number; b: number }>();
      for (let i = 0; i < keepCount; i++) {
        const p = inkPixels[i];
        const key = `${p.r >> 4},${p.g >> 4},${p.b >> 4}`;
        const entry = colourTally.get(key);
        if (entry) { entry.count++; }
        else { colourTally.set(key, { count: 1, r: p.r, g: p.g, b: p.b }); }
      }
      let bestEntry = { count: 0, r: 0, g: 0, b: 0 };
      for (const e of colourTally.values()) {
        if (e.count > bestEntry.count) bestEntry = e;
      }
      const colour: [number, number, number] = [bestEntry.r, bestEntry.g, bestEntry.b];

      // Map skeleton pixels to output grid cells.
      const outputCells = new Set<number>();
      const skelCellsList: Array<[number, number]> = [];
      for (let y = 0; y < compH; y++) {
        for (let x = 0; x < compW; x++) {
          if (bmp[y * compW + x] !== 1) continue;
          const srcPx = x + baseX;
          const srcPy = y + baseY;
          const gx = Math.floor(srcPx * rw / srcW) + ox;
          const gy = Math.floor(srcPy * rh / srcH) + oy;
          if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
            const cellIdx = gy * gridW + gx;
            if (!outputCells.has(cellIdx)) {
              outputCells.add(cellIdx);
              skelCellsList.push([gx, gy]);
            }
          }
        }
      }

      // Bridge 1-cell diagonal gaps between skeleton cells so the stroke is
      // 4-connected (no diagonal-only breaks that would render as a broken
      // line). For each pair of skeleton cells exactly one diagonal step
      // apart with no shared orthogonal cell already set, add the connecting
      // orthogonal cell.
      const skelSet = new Set(outputCells);
      for (const [gx, gy] of skelCellsList) {
        for (const [ddx, ddy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          const nx = gx + ddx, ny = gy + ddy;
          if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
          if (!skelSet.has(ny * gridW + nx)) continue;
          // diagonal neighbour present — ensure 4-connectivity via one bridge
          const b1 = gy * gridW + nx;
          const b2 = ny * gridW + gx;
          if (!skelSet.has(b1) && !skelSet.has(b2)) {
            outputCells.add(b1); // add horizontal-then-vertical bridge cell
          }
        }
      }

      console.log("segment skeleton mapped:", { bboxW, bboxH, sourcePixelCount: pixels.length, skeletonCellCount: outputCells.size, colour });
      if (outputCells.size > 0) {
        segments.push({ colour, outputCells });
      }
    }
  }

  return segments;
}

function smoothRgb(sourceRgb: Uint8Array, width: number, height: number, radius: number, whiteFloor: number): Uint8Array {
  if (radius <= 0) return sourceRgb;
  const out = new Uint8Array(sourceRgb.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const cr = sourceRgb[offset], cg = sourceRgb[offset + 1], cb = sourceRgb[offset + 2];
      if (isPlainWhite(cr, cg, cb, whiteFloor)) {
        out[offset] = 255; out[offset + 1] = 255; out[offset + 2] = 255;
        continue;
      }
      let r = 0, g = 0, b = 0, count = 0;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          const sampleOffset = (yy * width + xx) * 3;
          const sr = sourceRgb[sampleOffset], sg = sourceRgb[sampleOffset + 1], sb = sourceRgb[sampleOffset + 2];
          if (isPlainWhite(sr, sg, sb, whiteFloor)) continue;
          r += sr; g += sg; b += sb; count++;
        }
      }
      out[offset] = count ? Math.round(r / count) : cr;
      out[offset + 1] = count ? Math.round(g / count) : cg;
      out[offset + 2] = count ? Math.round(b / count) : cb;
    }
  }
  return out;
}

async function decodeImage(imageUrl: string): Promise<Image> {
  let bytes: Uint8Array;
  if (imageUrl.startsWith("data:")) {
    const comma = imageUrl.indexOf(",");
    const b64 = imageUrl.slice(comma + 1);
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const r = await fetch(imageUrl);
    if (!r.ok) throw new Error(`Failed to fetch imageUrl (${r.status})`);
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  const img = await decode(bytes);
  if (Array.isArray(img)) return img[0] as Image;
  return img as Image;
}

// Edge-preserving downsample. Pass 1 computes the box's flat mean and caches
// per-pixel RGB+Lab. Pass 2 seeds a second centroid as the pixel furthest from
// the mean in Lab, then runs 2 iterations of 2-means assignment. If both
// resulting clusters are non-trivial (smaller cluster has >=3 pixels AND >=8%
// of the box), we treat the smaller cluster as a real thin feature passing
// through the box (outline, line, edge) and emit its centroid — preventing
// dilution of 1-2px features into the surrounding background. Otherwise we
// emit the overall flat mean exactly as the prior implementation did.
const FAR_MIN_COUNT = 3;          // absolute minimum minority-cluster pixel count
const FAR_MIN_FRACTION = 0.05;    // minority must be >= 5% of box pixels
const BACKGROUND_MINORITY_MIN_COUNT = 2;     // against background, still require >=2px (reject single stray AA pixels)
const BACKGROUND_MINORITY_MIN_DIST_SQ = 150; // and a real Lab-distance from pure white (reject faint blend noise)
const WHITE_MINORITY_MIN_COUNT = 2;          // mirror case: a confidently-white minority against a non-white majority
const GENERAL_MINORITY_MIN_COUNT = 2;        // a genuinely distinct (non-white) colour minority against a non-white majority
const GENERAL_MINORITY_MIN_DIST_SQ = 900;    // must be genuinely high-contrast from the majority (~30 Lab units); excludes diffuse glass highlights/gradients (~800 distSq), preserves real distinct boundaries like lime rind vs liquid (~1000+ distSq)
const WHITE_LAB = rgbToLab(255, 255, 255);

function areaAverageResize(src: Image, rw: number, rh: number): Image {
  const sw = src.width;
  const sh = src.height;
  const out = new Image(rw, rh);
  // Mirror-symmetric source binning. The old inline floor-partition gave an
  // output column and its mirror partner source boxes offset by one pixel in
  // the same direction -- measured as ALL 78 of 78 columns mismatched for a
  // 1024px source resized to 78 cells. At ~13 source px per cell a consistent
  // 1px bias is enough to flip coverage across the 50% vote threshold at
  // different phases on the left and right edge of a symmetric shape, which
  // is what produced the reported "symmetrical steps" staircase defect on a
  // star (edges stepping at the same rate but permanently one row out of
  // phase). Same bug class as the vote-window fix (audit A2c); this is the
  // second, independent copy of it. Forced to satisfy b[n-k] === len - b[k]
  // exactly, so binning is mirror-exact by construction. Monotonic and
  // exactly covering; the only residual is the centre pair when the cell
  // count is even and the source dimension odd, which is geometric (an odd
  // pixel cannot split between two cells), not algorithmic.
  const symmetricResizeBounds = (cells: number, len: number): Int32Array => {
    const b = new Int32Array(cells + 1);
    for (let k = 0; k <= cells; k++) b[k] = Math.floor((k * len) / cells);
    for (let k = 0; k <= cells; k++) if (k < cells - k) b[cells - k] = len - b[k];
    return b;
  };
  const rxBound = symmetricResizeBounds(rw, sw);
  const ryBound = symmetricResizeBounds(rh, sh);
  for (let oy = 0; oy < rh; oy++) {
    const sy0 = ryBound[oy];
    const sy1 = Math.max(sy0 + 1, ryBound[oy + 1]);
    for (let ox = 0; ox < rw; ox++) {
      const sx0 = rxBound[ox];
      const sx1 = Math.max(sx0 + 1, rxBound[ox + 1]);
      const boxW = sx1 - sx0;
      const boxH = sy1 - sy0;
      const n = boxW * boxH;

      // Pass 1: flat mean + cache per-pixel RGB/A and Lab.
      const pxR = new Float64Array(n);
      const pxG = new Float64Array(n);
      const pxB = new Float64Array(n);
      const pxA = new Float64Array(n);
      const pxL = new Float64Array(n);
      const pxLa = new Float64Array(n);
      const pxLb = new Float64Array(n);
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      let i = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const px = src.getPixelAt(sx + 1, sy + 1);
          const pr = (px >>> 24) & 0xff;
          const pg = (px >>> 16) & 0xff;
          const pb = (px >>> 8) & 0xff;
          const pa = px & 0xff;
          pxR[i] = pr; pxG[i] = pg; pxB[i] = pb; pxA[i] = pa;
          const lab = rgbToLab(pr, pg, pb);
          pxL[i] = lab[0]; pxLa[i] = lab[1]; pxLb[i] = lab[2];
          rSum += pr; gSum += pg; bSum += pb; aSum += pa;
          i++;
        }
      }
      const meanR = rSum / n;
      const meanG = gSum / n;
      const meanB = bSum / n;
      const meanA = aSum / n;
      const meanLab = rgbToLab(meanR, meanG, meanB);

      // Seed centroid A = flat mean (in Lab). Seed centroid B = the pixel
      // furthest from A in Lab space.
      let aL = meanLab[0], aA = meanLab[1], aB = meanLab[2];
      let bIdx = 0;
      let bestD = -1;
      for (let k = 0; k < n; k++) {
        const dl = pxL[k] - aL, da = pxLa[k] - aA, db = pxLb[k] - aB;
        const d = dl * dl + da * da + db * db;
        if (d > bestD) { bestD = d; bIdx = k; }
      }
      let bL = pxL[bIdx], bA = pxLa[bIdx], bB = pxLb[bIdx];
      let cAr = 0, cAg = 0, cAb = 0, cAa = 0, cAn = 0;
      let cBr = 0, cBg = 0, cBb = 0, cBa = 0, cBn = 0;

      // 2 iterations of assignment + centroid recompute.
      for (let iter = 0; iter < 2; iter++) {
        cAr = 0; cAg = 0; cAb = 0; cAa = 0; cAn = 0;
        cBr = 0; cBg = 0; cBb = 0; cBa = 0; cBn = 0;
        let sumAL = 0, sumAa = 0, sumAb = 0;
        let sumBL = 0, sumBa = 0, sumBb = 0;
        for (let k = 0; k < n; k++) {
          const dlA = pxL[k] - aL, daA = pxLa[k] - aA, dbA = pxLb[k] - aB;
          const dA = dlA * dlA + daA * daA + dbA * dbA;
          const dlB = pxL[k] - bL, daB = pxLa[k] - bA, dbB = pxLb[k] - bB;
          const dB = dlB * dlB + daB * daB + dbB * dbB;
          if (dA <= dB) {
            cAr += pxR[k]; cAg += pxG[k]; cAb += pxB[k]; cAa += pxA[k]; cAn++;
            sumAL += pxL[k]; sumAa += pxLa[k]; sumAb += pxLb[k];
          } else {
            cBr += pxR[k]; cBg += pxG[k]; cBb += pxB[k]; cBa += pxA[k]; cBn++;
            sumBL += pxL[k]; sumBa += pxLa[k]; sumBb += pxLb[k];
          }
        }
        if (cAn > 0) { aL = sumAL / cAn; aA = sumAa / cAn; aB = sumAb / cAn; }
        if (cBn > 0) { bL = sumBL / cBn; bA = sumBa / cBn; bB = sumBb / cBn; }
      }

      // Decide. Smaller cluster = minority. If both clusters are non-trivial,
      // emit minority's RGB centroid; else fall back to overall mean.
      //
      // Against a background-white-dominated box, drop the size gate down to
      // "exists at all" (minN >= 1): there is no flat-fill risk to weigh
      // against here, since the only alternative to preserving a real sliver
      // of foreground is erasing it to blank page — which is exactly what
      // was dissolving thin stems and diagonal silhouette edges. Away from
      // background (i.e. inside a filled region, between two design
      // colours), keep the original conservative gate so we don't
      // manufacture noise out of ordinary anti-aliasing/shading variation.
      const minN = Math.min(cAn, cBn);
      const majorityIsA = cAn >= cBn;
      const majorN = majorityIsA ? cAn : cBn;
      const majorR = majorN > 0 ? (majorityIsA ? cAr : cBr) / majorN : meanR;
      const majorG = majorN > 0 ? (majorityIsA ? cAg : cBg) / majorN : meanG;
      const majorB = majorN > 0 ? (majorityIsA ? cAb : cBb) / majorN : meanB;
      const majorityIsBackground = isPlainWhite(majorR, majorG, majorB, 235);
      const minorR = minN > 0 ? (majorityIsA ? cBr : cAr) / minN : meanR;
      const minorG = minN > 0 ? (majorityIsA ? cBg : cAg) / minN : meanG;
      const minorB = minN > 0 ? (majorityIsA ? cBb : cAb) / minN : meanB;
      const minorityDistFromWhiteSq = labDistSq(rgbToLab(minorR, minorG, minorB), WHITE_LAB);
      // Symmetric case: a confidently-white minority (salt grains, pith
      // lines, a highlight stroke) running through a non-white majority
      // (the rim, the lime flesh, the stem) gets the same small-count
      // relaxation — mirror image of the background case above. Previously
      // this was still gated by the conservative 3px/5% rule, which is why
      // salt-rim detail wasn't surviving resize at all.
      const minorityIsWhite = isPlainWhite(minorR, minorG, minorB, 235);
      // General case: neither side is background or white — e.g. a second
      // stem tone, a glass highlight/shadow swoosh. Can't relax this
      // unconditionally (that reintroduces ordinary anti-aliasing/gradient
      // drift as fake "features" — the exact failure mode the original
      // conservative gate existed to prevent). Relax only when the minority
      // is a genuinely distinct colour from the local majority (a real
      // deliberate boundary, not a smooth blend), mirroring the
      // distance-from-white pattern above but measured against the
      // majority colour instead of pure white. Starting threshold — verify
      // against real colourDistSq values from postCeilingClusters/lineage
      // on the next test rather than assuming it's tuned correctly.
      const colourDistSq = labDistSq(rgbToLab(minorR, minorG, minorB), rgbToLab(majorR, majorG, majorB));
      const isDistinctColour = colourDistSq >= GENERAL_MINORITY_MIN_DIST_SQ;
      // "Light-on-light" guard: a near-white minority against a LIGHT
      // majority (e.g. a subtle reflection/highlight pixel inside the olive
      // liquid fill, avg RGB > 150) is almost certainly a gradient artifact,
      // not a real structural feature like a salt bead or pith line.
      // Those real features appear against DARK majorities (glass rim L≈37,
      // lime rind L≈37). Fall through to the conservative gate for the
      // light-on-light case so gradient highlights get absorbed into the
      // surrounding flat fill rather than leaking through as visible stitches.
      const majorityIsLight = (majorR + majorG + majorB) > 450;
      const lightOnLight = minorityIsWhite && majorityIsLight;
      // For very dark minority pixels against background (e.g. glass wall,
      // stem, lime rind — Lab distSq from white ≥ 3000), allow a single
      // pixel to survive: these are genuine thin-outline boundary stitches.
      // For lighter colours (olive liquid, lime flesh — distSq < 3000),
      // keep the conservative 2-pixel gate to avoid boundary noise.
      const isDarkOutlineColour = minorityDistFromWhiteSq >= 3000;
      const bgMinCount = isDarkOutlineColour ? 1 : BACKGROUND_MINORITY_MIN_COUNT;
      const minorityQualifies = majorityIsBackground
        ? (minN >= bgMinCount && minorityDistFromWhiteSq >= BACKGROUND_MINORITY_MIN_DIST_SQ)
        : lightOnLight
          ? (minN >= FAR_MIN_COUNT && minN >= n * FAR_MIN_FRACTION)
          : (minorityIsWhite && !majorityIsBackground)
            ? minN >= WHITE_MINORITY_MIN_COUNT
            : isDistinctColour
              ? minN >= GENERAL_MINORITY_MIN_COUNT
              : (minN >= FAR_MIN_COUNT && minN >= n * FAR_MIN_FRACTION);
      let outR: number, outG: number, outB: number, outA: number;
      if (minorityQualifies && cAn > 0 && cBn > 0) {
        const useA = cAn <= cBn;
        const mn = useA ? cAn : cBn;
        const sr = useA ? cAr : cBr;
        const sg = useA ? cAg : cBg;
        const sb = useA ? cAb : cBb;
        const sa = useA ? cAa : cBa;
        outR = Math.round(sr / mn) & 0xff;
        outG = Math.round(sg / mn) & 0xff;
        outB = Math.round(sb / mn) & 0xff;
        outA = Math.round(sa / mn) & 0xff;
      } else {
        outR = Math.round(meanR) & 0xff;
        outG = Math.round(meanG) & 0xff;
        outB = Math.round(meanB) & 0xff;
        outA = Math.round(meanA) & 0xff;
      }
      const packed = ((outR << 24) | (outG << 16) | (outB << 8) | outA) >>> 0;
      out.setPixelAt(ox + 1, oy + 1, packed);
    }
  }
  return out;
}

const SYMBOLS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789★☆●○◆◇■□▲△▼▽♠♥♦♣✚✦✪✱✳✺✿❀❂❄❉❋☀☂☘⚑⚙⚛⚜⚪⚫".split("");

type BorderInput = { style?: string; colors?: (string | null | undefined)[] } | null | undefined;

function stampBorderOnGrid(
  remapped: Uint16Array,
  gridW: number,
  gridH: number,
  border: BorderInput,
  palette: Raw[],
  palRgb: Rgb[],
  outPalette: Array<{ id: string; name: string; family: string; hex: string }>,
  sections: Array<{ name: string; paletteIndexes: number[] }>,
  outUsage: Record<string, number>,
  oldToNew: Map<number, number>,
  shape: string | null,
  canvasWidthInches: number,
  canvasHeightInches: number,
) {
  const style = (border?.style ?? "none").toLowerCase();
  const supported = new Set(["simple", "double", "ornate", "star", "floral", "folk"]);
  if (!supported.has(style)) return;
  const rawColors = (border?.colors ?? []).filter(
    (c): c is string => typeof c === "string" && /^#?[0-9a-fA-F]{6}$/.test(c.replace("#", "")),
  );
  if (!rawColors.length) return;

  // Shape geometry -- mirrors border-layers.ts's borderToLayer exactly.
  // `unrestricted` is true for a rectangle (or no shape), which routes
  // every branch below back to the original, byte-identical rectangle code.
  const mask = shape && shape !== "rectangle"
    ? shapeMask(shape, gridW, gridH, canvasWidthInches, canvasHeightInches)
    : null;
  const { grid: shapeGrid, depths, unrestricted } = depthsForMask(mask, gridW, gridH);
  const shaped = !unrestricted;

  function ensureColor(hex: string): number {
    const rgb = hexToRgb(hex.startsWith("#") ? hex : `#${hex}`);
    const palIdx = nearestPaletteIndex(rgb, palRgb);
    const existing = oldToNew.get(palIdx);
    if (existing !== undefined) return existing;
    const newIdx = outPalette.length;
    const p = palette[palIdx];
    outPalette.push({ id: p.id, name: p.n, family: p.f, hex: p.hex });
    oldToNew.set(palIdx, newIdx);
    let sec = sections.find((s) => s.name === p.f);
    if (!sec) {
      sec = { name: p.f, paletteIndexes: [] };
      sections.push(sec);
    }
    sec.paletteIndexes.push(newIdx);
    outUsage[String(newIdx)] = 0;
    return newIdx;
  }

  function setPx(x: number, y: number, ci: number) {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return;
    const i = y * gridW + x;
    const old = remapped[i];
    if (old === ci) return;
    remapped[i] = ci;
    const oldKey = String(old);
    outUsage[oldKey] = Math.max(0, (outUsage[oldKey] ?? 0) - 1);
    const newKey = String(ci);
    outUsage[newKey] = (outUsage[newKey] ?? 0) + 1;
  }

  /** Only paint where the shape allows. On a rectangle this is every cell. */
  function setPxInShape(x: number, y: number, ci: number) {
    if (x < 0 || y < 0 || x >= gridW || y >= gridH) return;
    if (shaped && depths[y * gridW + x] < 0) return;
    setPx(x, y, ci);
  }

  function drawFrame(inset: number, thickness: number, ci: number) {
    if (shaped) {
      for (const p of shapedFrameCells(depths, gridW, gridH, inset, thickness)) {
        setPx(p.x, p.y, ci);
      }
      return;
    }
    for (let t = 0; t < thickness; t++) {
      const o = inset + t;
      if (o * 2 + 1 >= gridW || o * 2 + 1 >= gridH) return;
      for (let x = o; x <= gridW - 1 - o; x++) {
        setPx(x, o, ci);
        setPx(x, gridH - 1 - o, ci);
      }
      for (let y = o; y <= gridH - 1 - o; y++) {
        setPx(o, y, ci);
        setPx(gridW - 1 - o, y, ci);
      }
    }
  }

  const thickness = Math.max(1, Math.min(2, Math.round(Math.min(gridW, gridH) / 120)));
  const inset = Math.max(2, Math.min(5, Math.round(Math.min(gridW, gridH) / 40)));

  if (style === "simple") {
    drawFrame(inset, thickness, ensureColor(rawColors[0]));
    return;
  }
  if (style === "double") {
    const c1 = ensureColor(rawColors[0]);
    const c2 = ensureColor(rawColors[1] ?? rawColors[0]);
    drawFrame(inset, thickness, c1);
    drawFrame(inset + thickness + 1, thickness, c2);
    return;
  }
  if (style === "ornate") {
    const c1 = ensureColor(rawColors[0]);
    const c2 = ensureColor(rawColors[1] ?? rawColors[0]);
    const c3 = ensureColor(rawColors[2] ?? rawColors[1] ?? rawColors[0]);
    // Outer frame thicker than inner, to match the preview.
    const outerThickness = Math.max(2, thickness + 1);
    const innerThickness = 1;
    drawFrame(inset, outerThickness, c1);
    drawFrame(inset + outerThickness + 1, innerThickness, c2);
    const r = 2;
    const stampDiamond = (cx: number, cy: number, fill: number, inner?: number) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= r) setPxInShape(cx + dx, cy + dy, fill);
        }
      }
      if (inner !== undefined) setPxInShape(cx, cy, inner);
    };
    if (shaped) {
      // A circle has no corners and no "edge midpoints", so the honest
      // generalisation of "4 corners + 4 midpoints" is 8 evenly spaced accents
      // around the ring. The alternating plain/centred pattern is preserved so
      // the style still reads as ornate rather than as a plain dotted ring.
      const accents = accentsAroundShape(shapeGrid, inset, 8);
      accents.points.forEach((p, i) => {
        if (i % 2 === 0) stampDiamond(p.x, p.y, c3);
        else stampDiamond(p.x, p.y, c3, c1);
      });
    } else {
      // Corner medallions
      const corners: Array<[number, number]> = [
        [inset, inset],
        [gridW - 1 - inset, inset],
        [inset, gridH - 1 - inset],
        [gridW - 1 - inset, gridH - 1 - inset],
      ];
      for (const [cx, cy] of corners) stampDiamond(cx, cy, c3);
      // Mid-edge baubles (centered on each side along the outer frame).
      const midX = Math.floor(gridW / 2);
      const midY = Math.floor(gridH / 2);
      stampDiamond(midX, inset, c3, c1);
      stampDiamond(midX, gridH - 1 - inset, c3, c1);
      stampDiamond(inset, midY, c3, c1);
      stampDiamond(gridW - 1 - inset, midY, c3, c1);
    }
    return;
  }

  // ---- Motif borders: spaced repeating stamps along each edge ----
  type Stamp = { w: number; h: number; cells: number[] };
  const STAMPS: Record<string, Stamp> = {
    // 8-point star: horizontal + vertical + 2 diagonals through the centre.
    star: {
      w: 7, h: 7, cells: [
        1,0,0,1,0,0,1,
        0,1,0,1,0,1,0,
        0,0,1,1,1,0,0,
        1,1,1,1,1,1,1,
        0,0,1,1,1,0,0,
        0,1,0,1,0,1,0,
        1,0,0,1,0,0,1,
      ],
    },
    flower: {
      w: 5, h: 5, cells: [
        0,0,1,0,0,
        0,1,1,1,0,
        1,1,2,1,1,
        0,1,1,1,0,
        0,0,1,0,0,
      ],
    },
    // Folk-art zigzag tooth (triangle).
    tooth: {
      w: 5, h: 5, cells: [
        0,0,1,0,0,
        0,1,1,1,0,
        0,1,1,1,0,
        1,1,1,1,1,
        1,1,1,1,1,
      ],
    },
    diamond: {
      w: 5, h: 5, cells: [
        0,0,1,0,0,
        0,1,1,1,0,
        1,1,1,1,1,
        0,1,1,1,0,
        0,0,1,0,0,
      ],
    },
  };

  function placeStamp(stamp: Stamp, cx: number, cy: number, palIdxs: number[]) {
    const x0 = cx - Math.floor(stamp.w / 2);
    const y0 = cy - Math.floor(stamp.h / 2);
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        const v = stamp.cells[y * stamp.w + x];
        // Clipped to the shape so a stamp near a curved edge cannot spill
        // outside the canvas; on a rectangle setPxInShape === setPx.
        if (v > 0) setPxInShape(x0 + x, y0 + y, palIdxs[v - 1] ?? palIdxs[0]);
      }
    }
  }

  // Evenly distribute stamps along a single edge segment of `edgeLen` cells,
  // using a target pitch (stamp + gap) so spacing matches across axes.
  function distributeWithPitch(edgeLen: number, stampSize: number, targetPitch: number): number[] {
    if (edgeLen < stampSize) return [];
    const n = Math.max(0, Math.round((edgeLen - stampSize) / targetPitch) + 1);
    if (n <= 0) return [];
    if (n === 1) return [Math.floor(edgeLen / 2)];
    const step = (edgeLen - stampSize) / (n - 1);
    const positions: number[] = [];
    for (let i = 0; i < n; i++) {
      positions.push(Math.round(i * step) + Math.floor(stampSize / 2));
    }
    return positions;
  }

  // Build the sequence of stamps for each motif style. The first entry is also
  // used as the corner stamp (placed once, upright, at each corner). The
  // remaining edge stamps alternate through the full sequence.
  type StampEntry = { stamp: Stamp; palSlots: number[] };
  let cornerEntry: StampEntry | null = null;
  let edgeSequence: StampEntry[] = [];
  if (style === "star") {
    const c1 = ensureColor(rawColors[0]);
    const s: StampEntry = { stamp: STAMPS.star, palSlots: [c1] };
    cornerEntry = s;
    edgeSequence = [s];
  } else if (style === "floral") {
    const petal = ensureColor(rawColors[0]);
    const center = ensureColor(rawColors[1] ?? rawColors[0]);
    const s: StampEntry = { stamp: STAMPS.flower, palSlots: [petal, center] };
    cornerEntry = s;
    edgeSequence = [s];
  } else if (style === "folk") {
    const toothC = ensureColor(rawColors[0]);
    const diamondC = ensureColor(rawColors[1] ?? rawColors[0]);
    const motifInset = Math.max(2, Math.min(6, Math.round(Math.min(gridW, gridH) / 50)));
    const TW = 5; // tooth base width
    const TD = 3; // tooth depth
    // Build a tooth (triangle) row along an edge.
    // edge: 'top' | 'bottom' | 'left' | 'right'
    const stampTooth = (edge: string, base: number, pos: number) => {
      // pos = center along edge axis. base = outer row/col.
      for (let d = 0; d < TD; d++) {
        const halfW = Math.max(0, Math.floor((TW - 1) / 2) - d);
        for (let k = -halfW; k <= halfW; k++) {
          if (edge === "top") setPx(pos + k, base + d, toothC);
          else if (edge === "bottom") setPx(pos + k, base - d, toothC);
          else if (edge === "left") setPx(base + d, pos + k, toothC);
          else setPx(base - d, pos + k, toothC);
        }
      }
    };
    if (shaped) {
      // Folk's teeth are DIRECTIONAL — each one points inward from its edge.
      // On a curve "inward" rotates continuously, and quarter turns are the
      // only lossless rotation on a stitch grid: anything else resamples the
      // stamp and destroys it. Rather than emit teeth at wrong angles, the
      // shaped path draws only the non-directional diamond chain (same
      // decision as border-layers.ts's borderToLayer).
      const dInsetShaped = motifInset + TD + 2;
      const run = stampsAroundShape(shapeGrid, dInsetShaped, 5);
      const dRadiusShaped = 1;
      for (const p of run.points) {
        for (let dy = -dRadiusShaped; dy <= dRadiusShaped; dy++) {
          for (let dx = -dRadiusShaped; dx <= dRadiusShaped; dx++) {
            if (Math.abs(dx) + Math.abs(dy) <= dRadiusShaped) {
              setPxInShape(p.x + dx, p.y + dy, diamondC);
            }
          }
        }
      }
      return;
    }
    // Pack teeth tightly along each edge.
    const innerLeft = motifInset + Math.floor(TW / 2);
    const innerRight = gridW - 1 - motifInset - Math.floor(TW / 2);
    const innerTop = motifInset + Math.floor(TW / 2);
    const innerBot = gridH - 1 - motifInset - Math.floor(TW / 2);
    const hCount = Math.max(0, Math.floor((innerRight - innerLeft) / TW) + 1);
    const vCount = Math.max(0, Math.floor((innerBot - innerTop) / TW) + 1);
    const hStep = hCount > 1 ? (innerRight - innerLeft) / (hCount - 1) : 0;
    const vStep = vCount > 1 ? (innerBot - innerTop) / (vCount - 1) : 0;
    for (let i = 0; i < hCount; i++) {
      const x = Math.round(innerLeft + i * hStep);
      stampTooth("top", motifInset, x);
      stampTooth("bottom", gridH - 1 - motifInset, x);
    }
    for (let i = 0; i < vCount; i++) {
      const y = Math.round(innerTop + i * vStep);
      stampTooth("left", motifInset, y);
      stampTooth("right", gridW - 1 - motifInset, y);
    }
    // Inner row of small diamonds, inset further from the teeth.
    const dInset = motifInset + TD + 2;
    const dRadius = 1;
    const dPitch = 5;
    const drawDiamond = (cx: number, cy: number) => {
      for (let dy = -dRadius; dy <= dRadius; dy++) {
        for (let dx = -dRadius; dx <= dRadius; dx++) {
          if (Math.abs(dx) + Math.abs(dy) <= dRadius) setPx(cx + dx, cy + dy, diamondC);
        }
      }
    };
    const dLeft = dInset + dRadius + 2;
    const dRight = gridW - 1 - dInset - dRadius - 2;
    const dTop = dInset + dRadius + 2;
    const dBot = gridH - 1 - dInset - dRadius - 2;
    const dhCount = Math.max(0, Math.floor((dRight - dLeft) / dPitch) + 1);
    const dvCount = Math.max(0, Math.floor((dBot - dTop) / dPitch) + 1);
    const dhStep = dhCount > 1 ? (dRight - dLeft) / (dhCount - 1) : 0;
    const dvStep = dvCount > 1 ? (dBot - dTop) / (dvCount - 1) : 0;
    for (let i = 0; i < dhCount; i++) {
      const x = Math.round(dLeft + i * dhStep);
      drawDiamond(x, dInset);
      drawDiamond(x, gridH - 1 - dInset);
    }
    for (let i = 0; i < dvCount; i++) {
      const y = Math.round(dTop + i * dvStep);
      drawDiamond(dInset, y);
      drawDiamond(gridW - 1 - dInset, y);
    }
    return;
  }

  if (cornerEntry && edgeSequence.length) {
    const motifInset = Math.max(2, Math.min(6, Math.round(Math.min(gridW, gridH) / 50)));
    const sW = cornerEntry.stamp.w;
    const sH = cornerEntry.stamp.h;
    const stampSize = Math.max(sW, sH);
    const targetGap = 3;
    const targetPitch = stampSize + targetGap;

    if (shaped) {
      // Star and flower are ROTATIONALLY SYMMETRIC — they read the same
      // whichever way the contour is heading — so unlike folk's teeth they can
      // follow a curve with no rotation at all. Even spacing around the traced
      // contour replaces the four-corners-plus-edges layout, which has no
      // meaning on a shape without corners.
      const inwardFromEdge = motifInset + Math.floor(stampSize / 2);
      const run = stampsAroundShape(shapeGrid, inwardFromEdge, targetPitch);
      for (const p of run.points) {
        placeStamp(cornerEntry.stamp, p.x, p.y, cornerEntry.palSlots);
      }
      return;
    }

    // Corner stamps — one upright stamp in each corner.
    const cornerXs = [motifInset + Math.floor(sW / 2), gridW - 1 - motifInset - Math.floor(sW / 2)];
    const cornerYs = [motifInset + Math.floor(sH / 2), gridH - 1 - motifInset - Math.floor(sH / 2)];
    for (const cy of cornerYs) {
      for (const cx of cornerXs) {
        placeStamp(cornerEntry.stamp, cx, cy, cornerEntry.palSlots);
      }
    }

    // Edge stamps between the corners (no overlap with corner stamps).
    const innerXStart = cornerXs[0] + Math.ceil(sW / 2) + targetGap;
    const innerXEnd = cornerXs[1] - Math.ceil(sW / 2) - targetGap;
    const innerYStart = cornerYs[0] + Math.ceil(sH / 2) + targetGap;
    const innerYEnd = cornerYs[1] - Math.ceil(sH / 2) - targetGap;
    const innerW = Math.max(0, innerXEnd - innerXStart);
    const innerH = Math.max(0, innerYEnd - innerYStart);

    const xs = distributeWithPitch(innerW, sW, targetPitch).map((p) => innerXStart + p);
    const ys = distributeWithPitch(innerH, sH, targetPitch).map((p) => innerYStart + p);

    let seqIdx = 0;
    const nextStamp = () => {
      const s = edgeSequence[seqIdx % edgeSequence.length];
      seqIdx++;
      return s;
    };

    const topY = cornerYs[0];
    const botY = cornerYs[1];
    const leftX = cornerXs[0];
    const rightX = cornerXs[1];

    for (const x of xs) {
      const s = nextStamp();
      placeStamp(s.stamp, x, topY, s.palSlots);
    }
    for (const x of xs) {
      const s = nextStamp();
      placeStamp(s.stamp, x, botY, s.palSlots);
    }
    for (const y of ys) {
      const s = nextStamp();
      placeStamp(s.stamp, leftX, y, s.palSlots);
    }
    for (const y of ys) {
      const s = nextStamp();
      placeStamp(s.stamp, rightX, y, s.palSlots);
    }
  }
}

// Confetti cleanup — finds small connected regions of a single palette index
// (lone stitches AND small clusters) and merges each into whichever
// neighbouring index borders it most. 4-way connectivity defines a region.
// Operates directly on the final remapped index grid and keeps `usage` counts
// accurate by transferring the merged region's stitch count to the colour it
// was merged into. Returns the number of regions removed.
// Scan the grid in all 4 directions (H, V, diagonal \, diagonal /) and
// mark every pixel that belongs to a run of ≥ minRun consecutive
// same-colour stitches. These pixels are protected from confetti cleanup
// regardless of their region size — they represent continuous line features
// (outlines, pith lines, salt rim arcs, stem edges) that must survive.
function buildLinearRunProtection(
  grid: Uint16Array,
  W: number,
  H: number,
  minRun: number = 3,
): Set<number> {
  const prot = new Set<number>();

  function check(indices: number[]) {
    if (indices.length < minRun) return;
    let runColor = grid[indices[0]];
    let runStart = 0;
    for (let i = 1; i <= indices.length; i++) {
      const color = i < indices.length ? grid[indices[i]] : -1;
      if (color === runColor) continue;
      if (i - runStart >= minRun) {
        for (let j = runStart; j < i; j++) prot.add(indices[j]);
      }
      runStart = i;
      runColor = color as number;
    }
  }

  // Horizontal
  for (let r = 0; r < H; r++) {
    const row: number[] = [];
    for (let c = 0; c < W; c++) row.push(r * W + c);
    check(row);
  }
  // Vertical
  for (let c = 0; c < W; c++) {
    const col: number[] = [];
    for (let r = 0; r < H; r++) col.push(r * W + c);
    check(col);
  }
  // Diagonal \ (down-right)
  for (let startR = 0; startR < H; startR++) {
    const diag: number[] = [];
    for (let r = startR, c = 0; r < H && c < W; r++, c++) diag.push(r * W + c);
    check(diag);
  }
  for (let startC = 1; startC < W; startC++) {
    const diag: number[] = [];
    for (let r = 0, c = startC; r < H && c < W; r++, c++) diag.push(r * W + c);
    check(diag);
  }
  // Anti-diagonal / (down-left)
  for (let startR = 0; startR < H; startR++) {
    const diag: number[] = [];
    for (let r = startR, c = W - 1; r < H && c >= 0; r++, c--) diag.push(r * W + c);
    check(diag);
  }
  for (let startC = W - 2; startC >= 0; startC--) {
    const diag: number[] = [];
    for (let r = 0, c = startC; r < H && c >= 0; r++, c--) diag.push(r * W + c);
    check(diag);
  }

  return prot;
}

function cleanConfetti(
  grid: Uint16Array,
  W: number,
  H: number,
  minSize: number,
  usage: Record<string, number>,
  protectedIds?: Set<number>,
  protectedPositions?: Set<number>,
): number {
  const N = W * H;
  const visited = new Uint8Array(N);
  let removed = 0;
  for (let start = 0; start < N; start++) {
    if (visited[start]) continue;
    const id = grid[start];
    const region: number[] = [];
    const stack: number[] = [start];
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      region.push(idx);
      const r = (idx / W) | 0, c = idx % W;
      // 8-connectivity: include diagonal neighbours so that 1-stitch-wide
      // diagonal arcs (salt rim curve, pith segment lines, glass outline
      // edges) are treated as one connected region rather than N isolated
      // single-stitch islands. Without this, each diagonal stitch gets
      // found as a separate size-1 region and cleaned up as confetti.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nr = r + dy, nc = c + dx;
          if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
          const n = nr * W + nc;
          if (!visited[n] && grid[n] === id) { visited[n] = 1; stack.push(n); }
        }
      }
    }
    if (protectedIds?.has(id)) continue;
      // Protect any region that contains a linear run of ≥3 stitches in
      // H/V/diagonal — thin pith lines, salt arcs, outline edges — even if
      // the total region size is below the confetti threshold.
      if (region.length <= minSize && !hasLinearRun(region, W, 3) && !(protectedPositions && region.some(p => protectedPositions.has(p)))) {
      const tally: Record<number, number> = {};
      for (const idx of region) {
        const r = (idx / W) | 0, c = idx % W;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const r2 = r + dy, c2 = c + dx;
            if (r2 < 0 || r2 >= H || c2 < 0 || c2 >= W) continue;
            const nb = grid[r2 * W + c2];
            if (nb === id) continue;
            tally[nb] = (tally[nb] ?? 0) + 1;
          }
        }
      }
      let bestId = -1, bestN = 0;
      for (const k in tally) { const n = tally[+k]; if (n > bestN) { bestN = n; bestId = +k; } }
      if (bestId >= 0) {
        for (const idx of region) grid[idx] = bestId;
        usage[String(id)] = Math.max(0, (usage[String(id)] ?? 0) - region.length);
        usage[String(bestId)] = (usage[String(bestId)] ?? 0) + region.length;
        removed++;
      }
    }
  }
  return removed;
}

// Returns true if the given set of pixel indices contains a run of ≥ minRun
// consecutive stitches in any of the 4 linear directions (H, V, diagonal \,
// anti-diagonal /). Used to protect thin outline and pith-line features from
// confetti cleanup even when their connected region is small.
function hasLinearRun(region: number[], W: number, minRun = 3): boolean {
  // Group row/col coordinates by each axis key, then check for consecutive runs.
  const byRow = new Map<number, number[]>();
  const byCol = new Map<number, number[]>();
  const byDiag1 = new Map<number, number[]>(); // r - c = const  (\)
  const byDiag2 = new Map<number, number[]>(); // r + c = const  (/)
  for (const idx of region) {
    const r = (idx / W) | 0, c = idx % W;
    (byRow.get(r) ?? (byRow.set(r, []), byRow.get(r)!)).push(c);
    (byCol.get(c) ?? (byCol.set(c, []), byCol.get(c)!)).push(r);
    const d1 = r - c;
    (byDiag1.get(d1) ?? (byDiag1.set(d1, []), byDiag1.get(d1)!)).push(r);
    const d2 = r + c;
    (byDiag2.get(d2) ?? (byDiag2.set(d2, []), byDiag2.get(d2)!)).push(r);
  }
  const checkRun = (groups: Map<number, number[]>): boolean => {
    for (const vals of groups.values()) {
      if (vals.length < minRun) continue;
      vals.sort((a, b) => a - b);
      let run = 1;
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] === vals[i - 1] + 1) { if (++run >= minRun) return true; }
        else run = 1;
      }
    }
    return false;
  };
  return checkRun(byRow) || checkRun(byCol) || checkRun(byDiag1) || checkRun(byDiag2);
}

// Pixel-level despeckle: a single stitch whose own colour has almost no
// support among its 8 immediate neighbours, while one other colour
// dominates around it, is very likely a stray misclassification (source
// noise tipping a pixel to the "wrong" nearest thread) rather than a
// deliberate feature. Genuine thin features (lines, arcs) are protected
// because their interior pixels keep 1-2 same-colour neighbours continuing
// their own run, which fails the "almost no support" gate. Runs once on
// the per-pixel index grid, before cleanConfetti and before border stamping.
const DESPECKLE_MAX_OWN_SUPPORT = 0;
const DESPECKLE_MIN_DOMINANT_SUPPORT = 6;

function despeckleGrid(grid: Uint16Array, W: number, H: number, usage: Record<string, number>, protectedIds?: Set<number>, protectedPositions?: Set<number>): number {
  const out = grid.slice();
  let flipped = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const own = grid[i];
      if (protectedIds?.has(own)) continue;
      if (protectedPositions?.has(i)) continue;
      const tally: Record<number, number> = {};
      let ownSupport = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          const n = grid[ny * W + nx];
          if (n === own) { ownSupport++; continue; }
          tally[n] = (tally[n] ?? 0) + 1;
        }
      }
      if (ownSupport > DESPECKLE_MAX_OWN_SUPPORT) continue;
      let bestId = -1, bestN = 0;
      for (const k in tally) { const n = tally[+k]; if (n > bestN) { bestN = n; bestId = +k; } }
      if (bestId >= 0 && bestN >= DESPECKLE_MIN_DOMINANT_SUPPORT) {
        out[i] = bestId;
        usage[String(own)] = Math.max(0, (usage[String(own)] ?? 0) - 1);
        usage[String(bestId)] = (usage[String(bestId)] ?? 0) + 1;
        flipped++;
      }
    }
  }
  grid.set(out);
  return flipped;
}

// Diagnostic-only: for each raw cluster, find its largest spatially-
// contiguous component size and how many separate components it has, by
// assigning every pixel in the (already resized+smoothed) grid to its
// nearest raw cluster and running 4-connected flood fill. This does NOT
// affect any merge decision — read-only instrumentation to test whether
// component size can distinguish "real distinct surface" (one or a few
// large compact blobs) from "shading/noise" (many small scattered specks)
// before committing to using it as a merge signal.
function computeRawClusterSpatialStats(
  pixelRgb: Uint8Array,
  gridW: number,
  gridH: number,
  clusters: ClusterColour[],
): Array<{ largestComponent: number; componentCount: number }> {
  const total = gridW * gridH;
  const clusterRgb: Rgb[] = clusters.map(c => c.rgb);
  const idxGrid = new Uint16Array(total);
  for (let i = 0; i < total; i++) {
    const offset = i * 3;
    const px: Rgb = [pixelRgb[offset], pixelRgb[offset + 1], pixelRgb[offset + 2]];
    idxGrid[i] = nearestRgbIndex(px, clusterRgb);
  }
  const stats = clusters.map(() => ({ largestComponent: 0, componentCount: 0 }));
  const visited = new Uint8Array(total);
  for (let start = 0; start < total; start++) {
    if (visited[start]) continue;
    const id = idxGrid[start];
    let size = 0;
    const stack: number[] = [start];
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      size++;
      const r = (idx / gridW) | 0, c = idx % gridW;
      if (c > 0) { const n = idx - 1; if (!visited[n] && idxGrid[n] === id) { visited[n] = 1; stack.push(n); } }
      if (c < gridW - 1) { const n = idx + 1; if (!visited[n] && idxGrid[n] === id) { visited[n] = 1; stack.push(n); } }
      if (r > 0) { const n = idx - gridW; if (!visited[n] && idxGrid[n] === id) { visited[n] = 1; stack.push(n); } }
      if (r < gridH - 1) { const n = idx + gridW; if (!visited[n] && idxGrid[n] === id) { visited[n] = 1; stack.push(n); } }
    }
    stats[id].componentCount++;
    if (size > stats[id].largestComponent) stats[id].largestComponent = size;
  }
  return stats;
}

// Identify final-palette indices that look like outline/ink strokes rather
// than fill regions: small population (thin lines cover few stitches) AND
// notably darker than the image's overall lightness (outline strokes in
// flat illustrations are conventionally a dark "ink" tone against lighter
// fills, not a small dark fill region). Flagged indices are protected from
// despeckle/confetti cleanup below, so a genuine — if fragmented at this
// resolution — outline isn't cleaned away as if it were stray noise.
const OUTLINE_MAX_POPULATION_FRACTION = 0.03;
const OUTLINE_MIN_LIGHTNESS_GAP = 20;

function findOutlineProtectedIndices(
  outPalette: Array<{ hex: string }>,
  outUsage: Record<string, number>,
  totalPixels: number,
): Set<number> {
  const protectedIds = new Set<number>();
  if (outPalette.length < 2) return protectedIds;
  const lightness = outPalette.map((p) => {
    const rgb = hexToRgb(p.hex);
    return rgbToLab(rgb[0], rgb[1], rgb[2])[0];
  });
  let weightedSum = 0, weightTotal = 0;
  outPalette.forEach((_, i) => {
    const pop = outUsage[String(i)] ?? 0;
    weightedSum += lightness[i] * pop;
    weightTotal += pop;
  });
  const avgL = weightTotal > 0 ? weightedSum / weightTotal : 50;
  outPalette.forEach((_, i) => {
    const pop = outUsage[String(i)] ?? 0;
    const fraction = totalPixels > 0 ? pop / totalPixels : 0;
    if (fraction > 0 && fraction <= OUTLINE_MAX_POPULATION_FRACTION && (avgL - lightness[i]) >= OUTLINE_MIN_LIGHTNESS_GAP) {
      protectedIds.add(i);
    }
  });
  return protectedIds;
}

// Normalise window frame borders: for each connected region of a light/cream
// colour that forms a rectangular frame (hollow rectangle — a ring of cells
// surrounding an interior of a different colour), enforce that the left and
// right border widths are equal, and the top and bottom border widths are
// equal. Trims the wider side by reverting excess cells to the most common
// surrounding non-frame colour. This corrects the asymmetric surround that
// results when a source window frame is a few pixels off-centre.
function normaliseWindowFrameBorders(
  remapped: Uint16Array,
  gridW: number,
  gridH: number,
  outPalette: Array<{ hex: string }>,
  outUsage: Record<string, number>,
  junctionCells: Set<number>,
): void {
  const bgIds = new Set<number>();
  const frameIds = new Set<number>();
  for (let i = 0; i < outPalette.length; i++) {
    const [r, g, b] = hexToRgb(outPalette[i].hex);
    const lab = rgbToLab(r, g, b);
    if (isPlainWhite(r, g, b, 230)) { bgIds.add(i); continue; }
    if (lab[0] >= 78) frameIds.add(i);
  }
  if (!frameIds.size) return;

  const N = gridW * gridH;
  const visited = new Uint8Array(N);

  for (let start = 0; start < N; start++) {
    if (visited[start] || !frameIds.has(remapped[start])) continue;

    const region: number[] = [];
    const queue = [start];
    visited[start] = 1;
    while (queue.length) {
      const idx = queue.shift()!;
      region.push(idx);
      const r = (idx / gridW) | 0, c = idx % gridW;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
        const ni = nr * gridW + nc;
        if (!visited[ni] && frameIds.has(remapped[ni])) { visited[ni] = 1; queue.push(ni); }
      }
    }

    let minR = gridH, maxR = 0, minC = gridW, maxC = 0;
    for (const idx of region) {
      const r = (idx / gridW) | 0, c = idx % gridW;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
    }
    const bboxH = maxR - minR + 1;
    const bboxW = maxC - minC + 1;

    if (bboxW < 6 || bboxH < 6) continue;

    const regionSet = new Set(region);
    let hasInterior = false;
    for (let r = minR + 1; r < maxR; r++) {
      for (let c = minC + 1; c < maxC; c++) {
        const idx = r * gridW + c;
        if (!regionSet.has(idx)) { hasInterior = true; break; }
      }
      if (hasInterior) break;
    }
    if (!hasInterior) continue;

    // First pass: measure raw per-row/column spans to identify which rows
    // are part of the top/bottom bar (span nearly the full bbox width) and
    // which columns are part of the left/right bar (span nearly the full
    // bbox height). These "bar rows/columns" must be excluded before
    // measuring border width, because a hollow rectangle's own top/bottom
    // bar looks identical to an oversized left-border reading if measured
    // the same way — leading to the bar being trimmed down to border width.
    const rawRowSpan: number[] = [];
    for (let r = minR; r <= maxR; r++) {
      let span = 0;
      for (let c = minC; c <= maxC; c++) { if (regionSet.has(r * gridW + c)) span++; }
      rawRowSpan.push(span);
    }
    const rawColSpan: number[] = [];
    for (let c = minC; c <= maxC; c++) {
      let span = 0;
      for (let r = minR; r <= maxR; r++) { if (regionSet.has(r * gridW + c)) span++; }
      rawColSpan.push(span);
    }
    const fullWidthThreshold = bboxW * 0.75;
    const fullHeightThreshold = bboxH * 0.75;
    const isBarRow = rawRowSpan.map(s => s >= fullWidthThreshold);
    const isBarCol = rawColSpan.map(s => s >= fullHeightThreshold);

    // Measure left/right border width only on non-bar rows (the rows that
    // actually show the side border, not the top/bottom bar itself).
    const rowLeftWidths: number[] = [];
    const rowRightWidths: number[] = [];
    for (let r = minR; r <= maxR; r++) {
      if (isBarRow[r - minR]) { rowLeftWidths.push(0); rowRightWidths.push(0); continue; }
      let lw = 0, rw = 0;
      for (let c = minC; c <= maxC; c++) { if (regionSet.has(r * gridW + c)) lw++; else break; }
      for (let c = maxC; c >= minC; c--) { if (regionSet.has(r * gridW + c)) rw++; else break; }
      rowLeftWidths.push(lw);
      rowRightWidths.push(rw);
    }
    const modeOf = (arr: number[]): number => {
      // Use the minimum non-zero width, not the mode. Since we only ever
      // trim (never extend), converging to the tightest observed border is
      // safe and guarantees we never end up thicker than the thinnest real
      // measurement — whereas the mode can still be pulled wide by a
      // plurality of over-wide rows near corners or adjacent shapes.
      const nonZero = arr.filter(v => v > 0);
      if (!nonZero.length) return 0;
      return Math.min(...nonZero);
    };
    const leftWidth = modeOf(rowLeftWidths);
    const rightWidth = modeOf(rowRightWidths);

    // Measure top/bottom border width only on non-bar columns.
    const colTopWidths: number[] = [];
    const colBottomWidths: number[] = [];
    for (let c = minC; c <= maxC; c++) {
      if (isBarCol[c - minC]) { colTopWidths.push(0); colBottomWidths.push(0); continue; }
      let tw = 0, bw = 0;
      for (let r = minR; r <= maxR; r++) { if (regionSet.has(r * gridW + c)) tw++; else break; }
      for (let r = maxR; r >= minR; r--) { if (regionSet.has(r * gridW + c)) bw++; else break; }
      colTopWidths.push(tw);
      colBottomWidths.push(bw);
    }
    const topWidth = modeOf(colTopWidths);
    const bottomWidth = modeOf(colBottomWidths);
    console.log("frame border normalise:", {
      bbox: { minR, maxR, minC, maxC },
      leftWidth, rightWidth, topWidth, bottomWidth,
      barRowCount: isBarRow.filter(Boolean).length,
      barColCount: isBarCol.filter(Boolean).length,
    });
    const nonBarRowCount = isBarRow.filter(v => !v).length;
    const zeroLeftCount = rowLeftWidths.filter((v, idx) => !isBarRow[idx] && v === 0).length;
    if (nonBarRowCount > 0 && zeroLeftCount / nonBarRowCount > 0.6) {
      console.log("frame border normalise: SKIPPING irregular region", { minR, maxR, minC, maxC });
      continue;
    }

    // Determine fill colour PER SIDE — a window can be adjacent to two
    // different colours (e.g. wall on one side, chimney on another), so a
    // single global fill colour risks recolouring trimmed cells with the
    // wrong neighbour's colour. Each side only looks at its own outward
    // neighbours.
    const fillColourForSide = (side: 'left' | 'right' | 'top' | 'bottom'): number => {
      const tally: Record<number, number> = {};
      for (const idx of region) {
        const r = (idx / gridW) | 0, c = idx % gridW;
        let nr = r, nc = c;
        if (side === 'left') nc = c - 1;
        else if (side === 'right') nc = c + 1;
        else if (side === 'top') nr = r - 1;
        else nr = r + 1;
        if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
        const nb = remapped[nr * gridW + nc];
        if (!frameIds.has(nb) && !bgIds.has(nb)) {
          tally[nb] = (tally[nb] ?? 0) + 1;
        }
      }
      let best = -1, bestCount = 0;
      for (const k in tally) { if (tally[+k] > bestCount) { bestCount = tally[+k]; best = +k; } }
      return best;
    };
    const fillLeft = fillColourForSide('left');
    const fillRight = fillColourForSide('right');
    const fillTop = fillColourForSide('top');
    const fillBottom = fillColourForSide('bottom');
    if (fillLeft < 0 && fillRight < 0 && fillTop < 0 && fillBottom < 0) continue;

    const frameColour = remapped[region[0]];

    if (leftWidth > 0 && fillLeft >= 0) {
      for (let r = minR; r <= maxR; r++) {
        if (isBarRow[r - minR]) continue;
        const actualLeft = rowLeftWidths[r - minR];
        if (actualLeft > leftWidth) {
          for (let col = minC + leftWidth; col < minC + actualLeft; col++) {
            const idx = r * gridW + col;
            if (regionSet.has(idx) && !junctionCells.has(idx)) {
              outUsage[String(frameColour)] = Math.max(0, (outUsage[String(frameColour)] ?? 0) - 1);
              outUsage[String(fillLeft)] = (outUsage[String(fillLeft)] ?? 0) + 1;
              remapped[idx] = fillLeft;
            }
          }
        }
        // No extend branch — only ever trim excess, never pad outward.
      }
    }
    if (rightWidth > 0 && fillRight >= 0) {
      for (let r = minR; r <= maxR; r++) {
        if (isBarRow[r - minR]) continue;
        const actualRight = rowRightWidths[r - minR];
        if (actualRight > rightWidth) {
          for (let col = maxC - actualRight + 1; col <= maxC - rightWidth; col++) {
            const idx = r * gridW + col;
            if (regionSet.has(idx) && !junctionCells.has(idx)) {
              outUsage[String(frameColour)] = Math.max(0, (outUsage[String(frameColour)] ?? 0) - 1);
              outUsage[String(fillRight)] = (outUsage[String(fillRight)] ?? 0) + 1;
              remapped[idx] = fillRight;
            }
          }
        }
      }
    }
    if (topWidth > 0 && fillTop >= 0) {
      for (let c = minC; c <= maxC; c++) {
        if (isBarCol[c - minC]) continue;
        const actualTop = colTopWidths[c - minC];
        if (actualTop > topWidth) {
          for (let row = minR + topWidth; row < minR + actualTop; row++) {
            const idx = row * gridW + c;
            if (regionSet.has(idx) && !junctionCells.has(idx)) {
              outUsage[String(frameColour)] = Math.max(0, (outUsage[String(frameColour)] ?? 0) - 1);
              outUsage[String(fillTop)] = (outUsage[String(fillTop)] ?? 0) + 1;
              remapped[idx] = fillTop;
            }
          }
        }
      }
    }
    if (bottomWidth > 0 && fillBottom >= 0) {
      for (let c = minC; c <= maxC; c++) {
        if (isBarCol[c - minC]) continue;
        const actualBottom = colBottomWidths[c - minC];
        if (actualBottom > bottomWidth) {
          for (let row = maxR - actualBottom + 1; row <= maxR - bottomWidth; row++) {
            const idx = row * gridW + c;
            if (regionSet.has(idx) && !junctionCells.has(idx)) {
              outUsage[String(frameColour)] = Math.max(0, (outUsage[String(frameColour)] ?? 0) - 1);
              outUsage[String(fillBottom)] = (outUsage[String(fillBottom)] ?? 0) + 1;
              remapped[idx] = fillBottom;
            }
          }
        }
      }
    }
  }
}






// Enforce symmetry between horizontally paired connected regions of the same
// colour. Finds pairs of same-colour regions that are:
//   - at the same vertical position (row extents overlap significantly)
//   - roughly equidistant from the canvas centre column
//   - similar in size (within 40% of each other)
// For each qualifying pair, mirrors the larger/more-complete region onto the
// smaller one, replacing it exactly. This corrects paired windows, window
// surrounds, and flanking elements that don't match due to source asymmetry.
// Only runs on non-background, non-pure-white colours to avoid touching
// the canvas background or pith/salt detail colours.
function enforcePairedRegionSymmetry(
  remapped: Uint16Array,
  gridW: number,
  gridH: number,
  outPalette: Array<{ hex: string }>,
  outUsage: Record<string, number>,
  junctionCells: Set<number>,
): void {
  const bgIds = new Set<number>();
  for (let i = 0; i < outPalette.length; i++) {
    const [r, g, b] = hexToRgb(outPalette[i].hex);
    if (isPlainWhite(r, g, b, 220)) bgIds.add(i);
  }

  const N = gridW * gridH;
  const visited = new Uint8Array(N);

  type Region = {
    colour: number;
    cells: number[];
    minR: number; maxR: number; minC: number; maxC: number;
    centreC: number; centreR: number;
  };
  const regions: Region[] = [];

  for (let start = 0; start < N; start++) {
    if (visited[start] || bgIds.has(remapped[start])) continue;
    const colour = remapped[start];
    const cells: number[] = [];
    const stack = [start];
    visited[start] = 1;
    let minR = gridH, maxR = 0, minC = gridW, maxC = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      cells.push(idx);
      const r = (idx / gridW) | 0, c = idx % gridW;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
        const ni = nr * gridW + nc;
        if (!visited[ni] && remapped[ni] === colour) { visited[ni] = 1; stack.push(ni); }
      }
    }
    if (cells.length < 4) continue;
    regions.push({
      colour, cells, minR, maxR, minC, maxC,
      centreC: (minC + maxC) / 2,
      centreR: (minR + maxR) / 2,
    });
  }

  const canvasCentreC = gridW / 2;

  const paired = new Set<number>();
  for (let i = 0; i < regions.length; i++) {
    if (paired.has(i)) continue;
    const a = regions[i];
    const aH = a.maxR - a.minR + 1;
    const aW = a.maxC - a.minC + 1;
    if (aW < 3 || aH < 3) continue;

    for (let j = i + 1; j < regions.length; j++) {
      if (paired.has(j)) continue;
      const b = regions[j];
      if (b.colour !== a.colour) continue;

      if (Math.abs(a.centreR - b.centreR) > 3) continue;
      const bH = b.maxR - b.minR + 1;
      if (Math.abs(aH - bH) > 3) continue;

      const aDist = Math.abs(a.centreC - canvasCentreC);
      const bDist = Math.abs(b.centreC - canvasCentreC);
      if (Math.abs(aDist - bDist) > 4) continue;

      if (a.centreC > canvasCentreC && b.centreC > canvasCentreC) continue;
      if (a.centreC < canvasCentreC && b.centreC < canvasCentreC) continue;

      const sizeRatio = Math.max(a.cells.length, b.cells.length) / Math.min(a.cells.length, b.cells.length);
      if (sizeRatio > 2.0) continue;

      paired.add(i); paired.add(j);
      const bgFill = [...bgIds][0] ?? 0;

      // Equalise row extents: find the shared (intersection) row range and
      // trim frame-colour cells outside it from both regions. This directly
      // fixes "one window runs a row taller than the other" without any
      // mirror-axis calculation that could drift if the motif isn't perfectly
      // centred in the grid.
      const sharedMinR = Math.max(a.minR, b.minR);
      const sharedMaxR = Math.min(a.maxR, b.maxR);
      const sharedMinC_a = a.minC, sharedMaxC_a = a.maxC;
      const sharedMinC_b = b.minC, sharedMaxC_b = b.maxC;
      // Also equalise column extents (use the narrower width, centred)
      const aW = a.maxC - a.minC;
      const bW = b.maxC - b.minC;
      const sharedW = Math.min(aW, bW);

      for (const region of [a, b]) {
        const colour = region.colour;
        // Trim rows outside shared row range
        for (const idx of region.cells) {
          const r = (idx / gridW) | 0;
          if (junctionCells.has(idx)) continue;
          if (r < sharedMinR || r > sharedMaxR) {
            if (remapped[idx] === colour) {
              outUsage[String(colour)] = Math.max(0, (outUsage[String(colour)] ?? 0) - 1);
              outUsage[String(bgFill)] = (outUsage[String(bgFill)] ?? 0) + 1;
              remapped[idx] = bgFill;
            }
          }
        }
        // Trim columns outside shared width (trim from the side that has more)
        const regionW = region.maxC - region.minC;
        if (regionW > sharedW) {
          const excess = regionW - sharedW;
          // Trim from left side: remove excess columns from minC
          const trimLeft = Math.ceil(excess / 2);
          const trimRight = Math.floor(excess / 2);
          for (const idx of region.cells) {
            const r = (idx / gridW) | 0;
            const c = idx % gridW;
            if (junctionCells.has(idx)) continue;
            if (r < sharedMinR || r > sharedMaxR) continue; // already trimmed
            const fromLeft = c - region.minC;
            const fromRight = region.maxC - c;
            if (fromLeft < trimLeft || fromRight < trimRight) {
              if (remapped[idx] === colour) {
                outUsage[String(colour)] = Math.max(0, (outUsage[String(colour)] ?? 0) - 1);
                outUsage[String(bgFill)] = (outUsage[String(bgFill)] ?? 0) + 1;
                remapped[idx] = bgFill;
              }
            }
          }
        }
      }

      break;
    }
  }
}

// Centre glazing bars within window frames so both columns of panes are
// equal width. The glazing bar (a vertical run of the frame colour inside
// the frame's hollow interior) is found and shifted to the exact midpoint
// of the interior column range. Does the same for horizontal bars.
// Centre any confirmed divider line within the enclosed region it splits.
// A divider line (already validated by the segment-detection system as a
// genuine thin structural feature) separates a bounded non-background area
// into two sub-regions. This pass finds each divider's two sub-regions,
// compares their cell counts, and shifts the divider by whole cells toward
// the smaller side until they're as balanced as possible. This is a
// universal fix: it works identically for window glazing bars, pith lines,
// salt rim segments, door surrounds, or any other divider — it has no
// knowledge of what the motif is, only that a line splits an enclosed area.
function centreDividerLines(
  remapped: Uint16Array,
  gridW: number,
  gridH: number,
  outPalette: Array<{ hex: string }>,
  outUsage: Record<string, number>,
  segmentStampedCells: Set<number>,
  junctionCells: Set<number>,
): void {
  const bgIds = new Set<number>();
  for (let i = 0; i < outPalette.length; i++) {
    const [r, g, b] = hexToRgb(outPalette[i].hex);
    if (isPlainWhite(r, g, b, 220)) bgIds.add(i);
  }
  if (segmentStampedCells.size === 0) return;

  const N = gridW * gridH;
  const visited = new Uint8Array(N);

  const lineComponents: number[][] = [];
  for (const start of segmentStampedCells) {
    if (visited[start]) continue;
    const colour = remapped[start];
    const cells: number[] = [];
    const stack = [start];
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      cells.push(idx);
      const r = (idx / gridW) | 0, c = idx % gridW;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
        const ni = nr * gridW + nc;
        if (!visited[ni] && segmentStampedCells.has(ni) && remapped[ni] === colour) {
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
    // Skip any line component that touches a junction — shifting a line
    // that crosses another would break the intersection. Junction-involved
    // dividers are left exactly as stamped.
    const touchesJunction = cells.some(c => junctionCells.has(c));
    if (cells.length >= 3 && !touchesJunction) lineComponents.push(cells);
  }

  // Detect cross/junction components: a component whose shape is NOT a
  // simple straight line (i.e. it has a branch point — a cell with 3+
  // same-colour 4-connected neighbours within the component) is a cross
  // where a horizontal and vertical bar meet. Shifting one arm of a cross
  // can corrupt the intersection cell (its "revert to pane colour" step has
  // no valid neighbour to sample, since all 4 sides are also line cells).
  // These are left untouched — only simple isolated dividers are shifted.
  const isJunctionComponent = (cells: number[]): boolean => {
    const cellSet = new Set(cells);
    for (const idx of cells) {
      const r = (idx / gridW) | 0, c = idx % gridW;
      let neighbourCount = 0;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const nr = r + dr, nc = c + dc;
        if (cellSet.has(nr * gridW + nc)) neighbourCount++;
      }
      if (neighbourCount >= 3) return true; // branch point found
    }
    return false;
  };

  for (const lineCells of lineComponents) {
    if (isJunctionComponent(lineCells)) continue; // never shift a cross/junction
    const colour = remapped[lineCells[0]];
    let minR = gridH, maxR = 0, minC = gridW, maxC = 0;
    for (const idx of lineCells) {
      const r = (idx / gridW) | 0, c = idx % gridW;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
      if (c < minC) minC = c; if (c > maxC) maxC = c;
    }
    const lineW = maxC - minC + 1;
    const lineH = maxR - minR + 1;
    const isVertical = lineW <= 2 && lineH >= 4;
    const isHorizontal = lineH <= 2 && lineW >= 4;
    if (!isVertical && !isHorizontal) continue;

    const lineSet = new Set(lineCells);

    if (isVertical) {
      const midRow = Math.round((minR + maxR) / 2);
      const leftStart = midRow * gridW + (minC - 1);
      const rightStart = midRow * gridW + (maxC + 1);
      if (minC - 1 < 0 || maxC + 1 >= gridW) continue;
      if (bgIds.has(remapped[leftStart]) || bgIds.has(remapped[rightStart])) continue;

      const countSide = (startIdx: number): number => {
        const seen = new Set<number>([startIdx]);
        const stack = [startIdx];
        let count = 0;
        const cap = 400;
        while (stack.length && count < cap) {
          const idx = stack.pop()!;
          count++;
          const r = (idx / gridW) | 0, c = idx % gridW;
          for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
            const ni = nr * gridW + nc;
            if (seen.has(ni) || lineSet.has(ni)) continue;
            if (bgIds.has(remapped[ni])) continue;
            seen.add(ni);
            stack.push(ni);
          }
        }
        return count;
      };

      const leftCount = countSide(leftStart);
      const rightCount = countSide(rightStart);
      if (leftCount === 0 || rightCount === 0) continue;
      const diff = leftCount - rightCount;
      const shift = Math.max(-2, Math.min(2, Math.round(diff / Math.max(leftCount, rightCount) * 4)));
      if (shift === 0) continue;

      for (const idx of lineCells) {
        const r = (idx / gridW) | 0, c = idx % gridW;
        let paneColour = -1;
        for (const [dr, dc] of [[0,-2],[0,2],[0,-1],[0,1]] as const) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
          const ni = nr * gridW + nc;
          if (!lineSet.has(ni) && !bgIds.has(remapped[ni])) { paneColour = remapped[ni]; break; }
        }
        if (paneColour < 0) continue;
        outUsage[String(colour)] = Math.max(0, (outUsage[String(colour)] ?? 0) - 1);
        outUsage[String(paneColour)] = (outUsage[String(paneColour)] ?? 0) + 1;
        remapped[idx] = paneColour;
      }
      for (const idx of lineCells) {
        const r = (idx / gridW) | 0, c = idx % gridW;
        const nc = c + shift;
        if (nc < 0 || nc >= gridW) continue;
        const ni = r * gridW + nc;
        const old = remapped[ni];
        if (!bgIds.has(old)) {
          outUsage[String(old)] = Math.max(0, (outUsage[String(old)] ?? 0) - 1);
        }
        outUsage[String(colour)] = (outUsage[String(colour)] ?? 0) + 1;
        remapped[ni] = colour;
      }
    } else {
      const midCol = Math.round((minC + maxC) / 2);
      const topStart = (minR - 1) * gridW + midCol;
      const bottomStart = (maxR + 1) * gridW + midCol;
      if (minR - 1 < 0 || maxR + 1 >= gridH) continue;
      if (bgIds.has(remapped[topStart]) || bgIds.has(remapped[bottomStart])) continue;

      const countSide = (startIdx: number): number => {
        const seen = new Set<number>([startIdx]);
        const stack = [startIdx];
        let count = 0;
        const cap = 400;
        while (stack.length && count < cap) {
          const idx = stack.pop()!;
          count++;
          const r = (idx / gridW) | 0, c = idx % gridW;
          for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
            const ni = nr * gridW + nc;
            if (seen.has(ni) || lineSet.has(ni)) continue;
            if (bgIds.has(remapped[ni])) continue;
            seen.add(ni);
            stack.push(ni);
          }
        }
        return count;
      };

      const topCount = countSide(topStart);
      const bottomCount = countSide(bottomStart);
      if (topCount === 0 || bottomCount === 0) continue;
      const diff = topCount - bottomCount;
      const shift = Math.max(-2, Math.min(2, Math.round(diff / Math.max(topCount, bottomCount) * 4)));
      if (shift === 0) continue;

      for (const idx of lineCells) {
        const r = (idx / gridW) | 0, c = idx % gridW;
        let paneColour = -1;
        for (const [dr, dc] of [[-2,0],[2,0],[-1,0],[1,0]] as const) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
          const ni = nr * gridW + nc;
          if (!lineSet.has(ni) && !bgIds.has(remapped[ni])) { paneColour = remapped[ni]; break; }
        }
        if (paneColour < 0) continue;
        outUsage[String(colour)] = Math.max(0, (outUsage[String(colour)] ?? 0) - 1);
        outUsage[String(paneColour)] = (outUsage[String(paneColour)] ?? 0) + 1;
        remapped[idx] = paneColour;
      }
      for (const idx of lineCells) {
        const r = (idx / gridW) | 0, c = idx % gridW;
        const nr = r + shift;
        if (nr < 0 || nr >= gridH) continue;
        const ni = nr * gridW + c;
        const old = remapped[ni];
        if (!bgIds.has(old)) {
          outUsage[String(old)] = Math.max(0, (outUsage[String(old)] ?? 0) - 1);
        }
        outUsage[String(colour)] = (outUsage[String(colour)] ?? 0) + 1;
        remapped[ni] = colour;
      }
    }
  }
}



Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // Diagnostics only: clear any values left over from a previous request that
  // shared this warm isolate. Never affects charting.
  resetChartDiag();
  try {
    const body = await req.json();
    const {
      imageUrl,
      brand,
      mesh,
      finishedWidthInches,
      finishedHeightInches,
      shading: shadingRaw = "medium",
      mode = "scene",
      border = null,
      cleanupLevel = "tidy",
      shape = null,
      // Input regime (technical plan §5.3): "generated" (flat AI art,
      // default) or "photo" (continuous-tone photograph). Photos need a much
      // higher colour budget and have no structural thin-line features.
      inputType = "generated",
    } = body ?? {};
    // Colour-limit default branches on input regime: generated flat art
    // flattens well at 24; photographs go muddy below ~40 and default to 48
    // (user-supplied maxColours always wins).
    const maxColours = body?.maxColours ?? (inputType === "photo" ? 48 : 24);
    // The client only sends maxColours once the user has actually touched the
    // control, so this distinguishes "user explicitly asked for N colours"
    // from "nobody chose, use the default". Without that distinction the
    // default (24) would silently override the artwork-derived estimate on
    // every generation, which is exactly what the estimate exists to prevent.
    const userSetMaxColours = typeof body?.maxColours === "number";
    console.log("inputType:", inputType, "maxColours:", maxColours);

    const shading = (typeof shadingRaw === "string" ? shadingRaw : "medium")
      .toLowerCase()
      .trim() as Shading;
    let validShading = ["none", "light", "medium", "heavy"].includes(shading)
      ? shading
      : "medium";
    if (mode === "motif" && validShading !== "none") {
      console.warn("mode=motif but shading requested was", validShading, "— forcing none");
      validShading = "none";
    }
    // Flat artwork has no continuous tone to model. Charting it with a
    // shading model manufactures intermediate blends that don't exist in the
    // source -- measured on a real upload: the source's flat regions contain
    // exactly 5 colours and no pink at all, yet medium shading produced a
    // pink AND a brown from red bleeding into its neighbours. "none" is not a
    // downgrade here, it is the correct model: ceiling 6, tight merge
    // threshold, no cluster inflation.
    if (inputType !== "photo" && validShading !== "none") {
      console.log("flat art detected — forcing shading from", validShading, "to none");
      validShading = "none";
    }

    // Truncate imageUrl in logs: keep enough to identify the storage object
    // (path + first ~16 chars of signed token) but drop the long JWT tail.
    const imageUrlForLog = typeof imageUrl === "string"
      ? (imageUrl.length > 160 ? imageUrl.slice(0, 160) + "…[truncated]" : imageUrl)
      : String(imageUrl);
    console.log(
      "chart request shading:", validShading,
      "mode:", mode,
      "maxColours:", maxColours,
      "mesh:", mesh,
      "finishedWidthInches:", finishedWidthInches,
      "finishedHeightInches:", finishedHeightInches,
      "brand:", brand,
      "cleanupLevel:", cleanupLevel,
      "imageUrl:", imageUrlForLog,
    );
    const CONFETTI_LEVELS: Record<string, number> = { off: 0, tidy: 1, max: 5 };
    const confettiMin = CONFETTI_LEVELS[String(cleanupLevel)] ?? 4;

    if (!imageUrl || !brand || !mesh || !finishedWidthInches || !finishedHeightInches) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Shading now controls the actual thread-selection stage. Each level first
    // builds a limited image-derived colour model, then maps pixels only to
    // those selected thread colours. This makes each setting visibly distinct.
    const shadingConfig: Record<Shading, { clusterMultiplier: number; smoothRadius: number; whiteFloor: number; mergeThreshold: number; ceiling: number }> = {
      // mergeThreshold is SQUARED Lab distance. 600 meant Lab distance 24.5 --
      // roughly 7x looser than every other row here, not "tight" as the note
      // above once described it. At that radius genuinely different hues fused:
      // a green background into grey (labDistSq 435, dE00 19.5), light blue
      // trim into white (338, dE00 12.8), teal into tan (362, dE00 18.8). It
      // also silently defeated the user's colour count, because this merge runs
      // after clustering and collapsed the result back down however many
      // clusters the quantiser had been given. 150 (Lab distance ~12.2) is
      // comparable to the dE 11 ceiling used by the later palette merge, so
      // real duplicates still collapse while distinct hues survive. Count
      // limiting stays with enforceColourCeiling, which already honours
      // maxColours.
      none:   { clusterMultiplier: 0.8, smoothRadius: 1, whiteFloor: 244, mergeThreshold: 150, ceiling: 6 },
      light:  { clusterMultiplier: 1,   smoothRadius: 2, whiteFloor: 247, mergeThreshold: 80,  ceiling: 14 },
      medium: { clusterMultiplier: 1.5, smoothRadius: 1, whiteFloor: 249, mergeThreshold: 50,  ceiling: 16 },
      heavy:  { clusterMultiplier: 1.5, smoothRadius: 0, whiteFloor: 248, mergeThreshold: 30,  ceiling: 18 },
    };
    const { clusterMultiplier, smoothRadius, whiteFloor, mergeThreshold, ceiling: shadingCeiling } = shadingConfig[validShading];
    // "Number of Colours" (maxColours) used to be silently overridden by this
    // table's fixed per-shading ceiling regardless of what the user actually
    // asked for. That ceiling predates shading being removable as a user
    // control (it's now fixed to "medium" for the only live generation path,
    // Single Motif) and predates the chartability prompt work that already
    // reduced how many genuinely-distinct colours a generation tends to
    // produce. Kept as a QUALITY FLOOR (still guards against confetti on a
    // low/default request), but it must never sit BELOW what the user
    // explicitly asked for. colourCap is removed entirely: it no longer
    // serves a purpose separate from this.
    // The shading ceiling (6 for "none") must never override an explicit user
    // request -- asking for more colours and receiving FEWER is indefensible.
    const ceiling = userSetMaxColours ? maxColours : Math.max(shadingCeiling, maxColours);
    const effectiveMaxColours = maxColours;


    const palette: Raw[] = brand === "dmc" ? DMC_PALETTE : APPLETONS_PALETTE;
    const palRgb = palette.map((p) => hexToRgb(p.hex));

    const gridW = Math.max(1, Math.round(finishedWidthInches * mesh));
    const gridH = Math.max(1, Math.round(finishedHeightInches * mesh));

    const img = await decodeImage(imageUrl);
    // contain into gridW x gridH preserving aspect
    const srcRatio = img.width / img.height;
    const dstRatio = gridW / gridH;
    let rw: number, rh: number;
    if (srcRatio > dstRatio) {
      rw = gridW;
      rh = Math.max(1, Math.round(gridW / srcRatio));
    } else {
      rh = gridH;
      rw = Math.max(1, Math.round(gridH * srcRatio));
    }
    const resized = areaAverageResize(img, rw, rh);

    // pad/center into gridW x gridH (white background)
    const padded = new Image(gridW, gridH);
    padded.fill(0xffffffff);
    const ox = Math.floor((gridW - rw) / 2);
    const oy = Math.floor((gridH - rh) / 2);
    padded.composite(resized, ox, oy);

    // Read source pixels once, then select an allowed thread set for the chosen
    // shading level. Lower shading levels deliberately get fewer image-derived
    // thread choices, so they produce flatter blocks instead of fine gradients.
    const total = gridW * gridH;
    const sourceRgb = new Uint8Array(total * 3);
    let hasPlainWhite = false;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const px = padded.getPixelAt(x + 1, y + 1);
        const offset = (y * gridW + x) * 3;
        const r = (px >>> 24) & 0xff;
        const g = (px >>> 16) & 0xff;
        const b = (px >>> 8) & 0xff;
        sourceRgb[offset] = r;
        sourceRgb[offset + 1] = g;
        sourceRgb[offset + 2] = b;
        if (isPlainWhite(r, g, b, whiteFloor)) hasPlainWhite = true;
      }
    }

    const shadedRgb = smoothRgb(sourceRgb, gridW, gridH, smoothRadius, whiteFloor);

    // Read full-resolution source pixels BEFORE cluster building so that
    // colour discrimination uses the original image rather than the 72×72
    // resized average. At low resolution, similar greens blend together and
    // collapse to one cluster; full-res preserves the distinct lime, liquid,
    // and glass colours. buildClusterColours subsamples internally so the
    // size is handled automatically.
    const srcW = img.width;
    const srcH = img.height;
    const srcPixelRgb = new Uint8Array(srcW * srcH * 3);
    for (let sy = 0; sy < srcH; sy++) {
      for (let sx = 0; sx < srcW; sx++) {
        const px = img.getPixelAt(sx + 1, sy + 1);
        const off = (sy * srcW + sx) * 3;
        srcPixelRgb[off]     = (px >>> 24) & 0xff;
        srcPixelRgb[off + 1] = (px >>> 16) & 0xff;
        srcPixelRgb[off + 2] = (px >>> 8)  & 0xff;
      }
    }
    // Source-pixel census. The engine receives a browser-exported crop, not
    // the user's original file; if that export is downscaled or re-encoded,
    // thin dark strokes blend to mid-grey before any detection runs and no
    // downstream sampling can recover them. Measuring rather than assuming.
    {
      let minSum = 765, darkCount = 0, veryDarkCount = 0, total = 0;
      const darkTally = new Map<string, number>();
      for (let i = 0; i < srcW * srcH; i++) {
        const o = i * 3;
        const s = srcPixelRgb[o] + srcPixelRgb[o + 1] + srcPixelRgb[o + 2];
        total++;
        if (s < minSum) minSum = s;
        if (s < 250) veryDarkCount++;
        if (s < 450) {
          darkCount++;
          const key = `${srcPixelRgb[o] >> 4},${srcPixelRgb[o + 1] >> 4},${srcPixelRgb[o + 2] >> 4}`;
          darkTally.set(key, (darkTally.get(key) ?? 0) + 1);
        }
      }
      const topDark = [...darkTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([k, n]) => ({ bucket: k, n }));
      const stats = {
        srcW, srcH, total,
        minPixelSum: minSum,
        pixelsUnder250: veryDarkCount,
        pixelsUnder450: darkCount,
        fracUnder250: Math.round((veryDarkCount / total) * 100000) / 100000,
        topDarkBuckets: topDark,
      };
      console.log("sourceStats:", JSON.stringify(stats));
      CHART_DIAG.sourceStats = stats;
    }
    // Moved earlier: only depends on srcPixelRgb, needed before palette
    // derivation now so thin-line pixels (including fine script text, not
    // just the object outline) can be protected from the median denoise
    // below. A median filter's known weakness is erasing features smaller
    // than its window -- exactly what happened to "Diet"'s script strokes
    // when this ran after denoising with no protection.
    const thinLineMap = detectThinLinePixels(srcPixelRgb, srcW, srcH, 50);
    {
      let flagged = 0, flaggedDark = 0;
      for (let i = 0; i < srcW * srcH; i++) {
        if (!thinLineMap[i]) continue;
        flagged++;
        const o = i * 3;
        if (srcPixelRgb[o] + srcPixelRgb[o + 1] + srcPixelRgb[o + 2] < 250) flaggedDark++;
      }
      const tl = { flagged, flaggedDark };
      console.log("thinLineMap:", JSON.stringify(tl));
      CHART_DIAG.sourceStats = { ...(CHART_DIAG.sourceStats as Record<string, unknown>), thinLine: tl };
    }


    // Flat art only: photographs are continuous-tone by definition and their
    // "edge" pixels are real image content, not artifacts.
    // Computed ONCE and shared by both palette-derivation consumers below;
    // every other consumer of srcPixelRgb stays on the unfiltered pixels.
    const denoiseStart = Date.now();
    const paletteSourceRgb = inputType === "photo"
      ? srcPixelRgb
      : medianDenoise(srcPixelRgb, srcW, srcH);
    if (paletteSourceRgb !== srcPixelRgb) {
      console.log("palette median denoise ms:", Date.now() - denoiseStart);
      // Restore ONE colour per connected thin-line component -- its modal
      // raw colour -- rather than every pixel's own raw value. A stroke is
      // one ink colour; per-pixel restore re-injected each stroke's JPEG/
      // anti-aliasing noise into palette derivation, the exact speckle the
      // median denoise exists to remove. Pixels whose raw colour is far
      // from the component's mode (a different-coloured stroke fused into
      // the same component) keep their raw value instead of being repainted.
      {
        const visited = new Uint8Array(thinLineMap.length);
        const stack: number[] = [];
        for (let s = 0; s < thinLineMap.length; s++) {
          if (!thinLineMap[s] || visited[s]) continue;
          const comp: number[] = [];
          visited[s] = 1; stack.length = 0; stack.push(s);
          while (stack.length) {
            const i = stack.pop()!;
            comp.push(i);
            const py = (i / srcW) | 0, px = i % srcW;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const ny = py + dy, nx = px + dx;
                if (ny < 0 || ny >= srcH || nx < 0 || nx >= srcW) continue;
                const ni = ny * srcW + nx;
                if (thinLineMap[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni); }
              }
            }
          }
          const tally = new Map<number, number>();
          for (const i of comp) {
            const off = i * 3;
            const key = (srcPixelRgb[off] << 16) | (srcPixelRgb[off + 1] << 8) | srcPixelRgb[off + 2];
            tally.set(key, (tally.get(key) ?? 0) + 1);
          }
          let modal = 0, best = 0;
          for (const [k, n] of tally) if (n > best) { best = n; modal = k; }
          const mr = (modal >> 16) & 255, mg = (modal >> 8) & 255, mb = modal & 255;
          for (const i of comp) {
            const off = i * 3;
            const d = Math.abs(srcPixelRgb[off] - mr) + Math.abs(srcPixelRgb[off + 1] - mg) + Math.abs(srcPixelRgb[off + 2] - mb);
            if (d > 90) {
              paletteSourceRgb[off] = srcPixelRgb[off];
              paletteSourceRgb[off + 1] = srcPixelRgb[off + 1];
              paletteSourceRgb[off + 2] = srcPixelRgb[off + 2];
            } else {
              paletteSourceRgb[off] = mr;
              paletteSourceRgb[off + 1] = mg;
              paletteSourceRgb[off + 2] = mb;
            }
          }
        }
      }
    }
    const flatMask = inputType === "photo"
      ? null
      : computeFlatRegionMask(paletteSourceRgb, srcW, srcH);
    if (flatMask) {
      let flatCount = 0;
      for (let i = 0; i < flatMask.length; i++) flatCount += flatMask[i];
      console.log("flat-region palette derivation:", JSON.stringify({
        flatPixels: flatCount,
        totalPixels: flatMask.length,
        edgeFraction: Math.round((1 - flatCount / flatMask.length) * 100) / 100,
      }));
    }
    // Flat art: derive the budget from the artwork's own measured colour
    // count instead of a fixed floor, which guarantees overshoot on simple
    // artwork regardless of anything else in the pipeline (measured: a real
    // 5-colour icon was still floored to a minimum of 16 quantiser bins).
    // +2 buffer allows legitimate anti-aliased accent tones some room
    // without inviting the noise a full extra 11 bins invites back in.
    // Flat-art colour budget.
    //
    // The estimate is measured over computeFlatRegionMask so anti-aliasing
    // blends along edges aren't counted as real design colours. That is right
    // for a clean vector-style icon, where the flat regions ARE the design's
    // colour fields. It is badly wrong for textured artwork -- a hand-coloured
    // engraving, a photo of framed fabric -- where the only genuinely flat
    // region is the blank paper margin and every actual colour lives in
    // hatching or weave. Measured on two real uploads: 5 and 9 colours over
    // the flat regions versus 21 and 39 over the whole image, so the quantiser
    // got 7 and 11 bins for artwork needing far more, and spent them all on
    // the dominant neutral mass. The hues were never given a bin to land in.
    //
    // So: if the flat regions are dramatically poorer in colour than the image
    // as a whole, they are a margin/backdrop rather than the design, and the
    // whole-image measurement is the trustworthy one. Capped at 24 so a noisy
    // or heavily anti-aliased source can't run the budget away.
    //
    // And an explicit user request always raises the budget: previously
    // maxColours only capped `allowed` downstream, so asking for more colours
    // could not create the clusters needed to represent them -- the control
    // genuinely could not work on this path.
    let flatArtEstimate = 3;
    if (inputType !== "photo") {
      const flatRegionEstimate = estimateNaturalColourCount(paletteSourceRgb, flatMask!, srcW * srcH);
      const wholeImageEstimate = estimateNaturalColourCount(paletteSourceRgb, null, srcW * srcH);
      flatArtEstimate = wholeImageEstimate > flatRegionEstimate * 2
        ? Math.min(wholeImageEstimate, 24)
        : flatRegionEstimate;
      if (userSetMaxColours) flatArtEstimate = Math.max(flatArtEstimate, maxColours);
      console.log("flat-art colour budget:", JSON.stringify({
        flatRegionEstimate,
        wholeImageEstimate,
        userSetMaxColours,
        maxColours,
        chosen: flatArtEstimate,
      }));
    }
    const clusterCount = inputType === "photo"
      ? Math.max(16, Math.round(effectiveMaxColours * clusterMultiplier))
      : Math.max(3, flatArtEstimate + 2);
    const clusterColoursRaw0 = buildClusterColours(paletteSourceRgb, srcW * srcH, clusterCount, hasPlainWhite, flatMask);
    // Guarantee locally-contrasting details a seat at the table. These are
    // features a person would name when describing the picture (a collar, a
    // ribbon) that are too small to win a population-weighted median-cut box
    // but plainly visible once stitched. Only islands with no existing
    // representative are added, so this cannot inflate the palette on an
    // image whose details are already covered.
    const salientIslands = findSalientColourIslands(paletteSourceRgb, srcW, srcH, gridW, gridH);
    const clusterColoursRaw = [...clusterColoursRaw0];
    for (const isl of salientIslands) {
      const il = rgbToLab(isl.rgb[0], isl.rgb[1], isl.rgb[2]);
      let nearest = Infinity;
      for (const c of clusterColoursRaw) {
        const d = ciede2000(il, rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));
        if (d < nearest) nearest = d;
      }
      if (nearest >= 12) clusterColoursRaw.push({ rgb: isl.rgb, population: isl.stitches });
    }
    if (salientIslands.length) {
      console.log("salient colour islands:", JSON.stringify(
        salientIslands.slice(0, 8).map((i) => ({ rgb: i.rgb, stitches: i.stitches })),
      ));
    }

    // Thin line pixels (computed above) are weighted in the majority vote

    const THIN_LINE_VOTE_WEIGHT = 6; // thin line pixels count 6x in majority vote
    // Detect line segments as geometric objects for post-vote stamping
    // Structural thin-line detection applies to generated flat art only:
    // photographs have no glazing bars / frames / pith lines to detect, and
    // running the detector on photographic gradients produces false-positive
    // segments (technical plan §5.3).
    const lineSegments = inputType === "photo"
      ? []
      : detectLineSegments(srcPixelRgb, srcW, srcH, thinLineMap, gridW, gridH, rw, rh, ox, oy);
    if (inputType === "photo") console.log("photo mode: structural detection disabled");
    console.log("lineSegments detected:", lineSegments.length, "total output cells:", lineSegments.reduce((s, seg) => s + seg.outputCells.size, 0));

    // Cluster segment colours together so visually-identical structural lines
    // (multiple glazing bars, multiple window frames) all resolve to ONE
    // shared thread rather than each independently picking its own nearest
    // match and landing on two near-identical but different Appletons shades.
    // Tolerance picked to merge anti-aliasing variance within the same
    // physical line colour while keeping genuinely different colours (navy
    // outline vs cream glazing bar) separate.
    const SEGMENT_COLOUR_CLUSTER_DIST_SQ = 400; // ~20 Lab units
    // Membership is tested against the cluster's IMMUTABLE SEED, never its
    // running mean, and additionally capped on lightness difference.
    //
    // The original tested against a mean that was mutated on every match,
    // with a first-match break. That chains: a black stroke matches a mid
    // grey within tolerance, the mean moves lighter, which brings a lighter
    // stroke into range, which moves the mean again -- the cluster walks up
    // the lightness axis and ends up pale, dragging every black stroke with
    // it. Measured live: all 324 segments detected from black handwriting
    // shared ONE cluster whose representative colour was pale putty grey
    // #D9D3C8 (pixSum 584 of 765). That is why no black was ever stamped,
    // and why grey spread across the whole chart -- the stamper was doing
    // its job correctly with a colour that existed nowhere in the artwork.
    //
    // Seed-anchoring keeps the original intent intact (several glazing bars
    // of the SAME physical colour still collapse to one thread, because they
    // all sit within tolerance of the first one seen) while making
    // transitive drift impossible. The lightness cap is a second, independent
    // guard: ink of markedly different darkness is never the same line
    // colour, whatever the Lab distance says.
    const SEGMENT_COLOUR_CLUSTER_MAX_DL = 12;
    type SegColourCluster = { seedLab: [number, number, number]; lab: [number, number, number]; rgb: [number, number, number]; count: number };
    const segColourClusters: SegColourCluster[] = [];
    for (const seg of lineSegments) {
      const segLab = rgbToLab(seg.colour[0], seg.colour[1], seg.colour[2]);
      let matched: SegColourCluster | null = null;
      let bestD = Infinity;
      for (const cluster of segColourClusters) {
        const d = labDistSq(segLab, cluster.seedLab);
        if (d > SEGMENT_COLOUR_CLUSTER_DIST_SQ) continue;
        if (Math.abs(segLab[0] - cluster.seedLab[0]) > SEGMENT_COLOUR_CLUSTER_MAX_DL) continue;
        // Nearest matching seed, not merely the first -- with a fixed seed
        // the first match is an arbitrary function of segment ordering.
        if (d < bestD) { bestD = d; matched = cluster; }
      }
      if (matched) {
        const n = matched.count + 1;
        matched.rgb = [
          Math.round((matched.rgb[0] * matched.count + seg.colour[0]) / n),
          Math.round((matched.rgb[1] * matched.count + seg.colour[1]) / n),
          Math.round((matched.rgb[2] * matched.count + seg.colour[2]) / n),
        ];
        matched.lab = rgbToLab(matched.rgb[0], matched.rgb[1], matched.rgb[2]);
        matched.count = n;
        (seg as any).clusterRef = matched;
      } else {
        const newCluster: SegColourCluster = { seedLab: segLab, lab: segLab, rgb: [...seg.colour], count: 1 };
        segColourClusters.push(newCluster);
        (seg as any).clusterRef = newCluster;
      }
    }
    console.log("segColourClusters:", segColourClusters.map(c => ({ rgb: c.rgb, count: c.count })));
    CHART_DIAG.segColourClusters = segColourClusters.map(c => ({ rgb: c.rgb, count: c.count, pixSum: c.rgb[0] + c.rgb[1] + c.rgb[2] }));
    console.log("rawClusters", clusterColoursRaw.map(c => ({ rgb: c.rgb, population: c.population })));
    const rawClusterSpatialStats = computeRawClusterSpatialStats(shadedRgb, gridW, gridH, clusterColoursRaw);
    console.log("rawClusterSpatialStats", clusterColoursRaw.map((c, i) => ({
      rgb: c.rgb,
      population: c.population,
      largestComponent: rawClusterSpatialStats[i].largestComponent,
      componentCount: rawClusterSpatialStats[i].componentCount,
    })));
    const clusterColoursMerged = mergeSimilarClusters(clusterColoursRaw, mergeThreshold, rawClusterSpatialStats);
    const clusterColoursCeil = enforceColourCeiling(clusterColoursMerged, ceiling);
    const topSurvivors = [...clusterColoursCeil].sort((a, b) => b.population - a.population).slice(0, 3)
      .map(c => ({ rgb: c.rgb, population: c.population }));
    console.log("mergeSimilarClusters", { shading: validShading, mergeThreshold, ceiling, postCluster: clusterColoursRaw.length, postThreshold: clusterColoursMerged.length, postCeiling: clusterColoursCeil.length, topSurvivors });
    console.log("postCeilingClusters", clusterColoursCeil.map(c => ({ rgb: c.rgb, population: c.population })));
    // Sort by population descending so dominant colours claim their
    // best-match thread first. Without this, a minor cluster could take
    // the ideal thread for the dominant colour, pushing it onto a poor match.
    // Sort clusters by population descending so dominant colours get first
    // pick of threads (unchanged from before).
    const sortedClusters = [...clusterColoursCeil].sort((a, b) => b.population - a.population);
    const clusterColours: Rgb[] = sortedClusters.map(c => c.rgb);
    const allowed = new Set<number>();
    if (hasPlainWhite) allowed.add(nearestPaletteIndex([255, 255, 255], palRgb));

    // Build cluster→thread mapping EXPLICITLY so pixel assignment can
    // use it. Clusters below MIN_CLUSTER_POP don't get their own distinct
    // thread — they map to nearest existing thread so their pixels blend
    // into the closest dominant colour rather than creating isolated noise
    // stitches of an otherwise-unused colour (F, G etc.).
    const MIN_CLUSTER_POP = 150;
    // Audit A4. MIN_CLUSTER_POP exists to stop NOISE creating isolated
    // stitches of an otherwise-unused thread. Noise is by definition
    // perceptually CLOSE to its surroundings (compression ringing around a
    // real colour); a genuine accent is perceptually DISTANT from everything
    // else. So a small cluster survives if it is far from every thread
    // already claimed -- the same reasoning that already exempts near-white
    // pith/salt, generalised beyond white. ACCENT_FLOOR still rejects literal
    // specks, so this cannot resurrect single-pixel noise.
    const ACCENT_MIN_DE = 25;
    const ACCENT_FLOOR = 24;
    const clusterDesignatedThreads: number[] = sortedClusters.map(cluster => {
      // Near-white clusters (salt rim, pith lines) are always small-population
      // by nature — they're thin detail features. Always give them a distinct
      // thread regardless of population so salt and pith survive into the palette.
      const isNearWhiteCluster = (cluster.rgb[0] + cluster.rgb[1] + cluster.rgb[2]) > 680;
      let isDistinctAccent = false;
      if (!isNearWhiteCluster && cluster.population >= ACCENT_FLOOR && cluster.population < MIN_CLUSTER_POP) {
        const cLab = rgbToLab(cluster.rgb[0], cluster.rgb[1], cluster.rgb[2]);
        let nearest = Infinity;
        for (const t of allowed) {
          const [tr, tg, tb] = palRgb[t];
          const d = ciede2000(cLab, rgbToLab(tr, tg, tb));
          if (d < nearest) nearest = d;
        }
        isDistinctAccent = nearest >= ACCENT_MIN_DE;
        if (isDistinctAccent) {
          console.log("accent survival:", JSON.stringify({
            rgb: cluster.rgb, population: cluster.population,
            nearestAllowedDE: Math.round(nearest * 100) / 100,
          }));
        }
      }
      if (
        (cluster.population < MIN_CLUSTER_POP && !isNearWhiteCluster && !isDistinctAccent && !cluster.protected) ||
        (allowed.size >= effectiveMaxColours && !cluster.protected)
      ) {
        return nearestPaletteIndex(cluster.rgb, palRgb);
      }
      // Prefer a thread no earlier cluster claimed, but NEVER at the cost of a
      // materially worse colour match. The unconditional exclude-set forced
      // same-family clusters (a green background, a sepia engraving's many
      // creams) progressively further from their true colour, across the
      // neutral axis into greys and blacks -- measured: a green cluster driven
      // from its correct green thread (dE00 8.51) onto a near-black (dE00
      // 15.97) purely because an earlier green had taken it. If two clusters
      // genuinely ARE the same colour, resolving both to the same thread is
      // the CORRECT answer; the near-duplicate merge passes below then collapse
      // them properly instead of inventing false variety here.
      // Family by hue, shade by lightness, distinctness within the family only.
      const thread = pickThreadInFamily(cluster.rgb, palette, palRgb, allowed);
      allowed.add(thread);
      return thread;
    });
    // Real hex of whichever thread(s) a reserved (vivid/dark-neutral)
    // cluster resolved to, captured now while cluster/thread lineage is
    // still directly available. Matched by VALUE against outPalette further
    // down rather than by index, because index positions do not survive the
    // remap/compaction the later merge passes perform.
    const protectedThreadHexes = new Set<string>();
    // Same set as palette INDICES. Needed because the output palette is built
    // from the usage map, which cannot see a thread that has zero cells yet.
    const protectedThreadIdx = new Set<number>();
    sortedClusters.forEach((cluster, i) => {
      if (cluster.protected) {
        protectedThreadHexes.add(palette[clusterDesignatedThreads[i]].hex);
        protectedThreadIdx.add(clusterDesignatedThreads[i]);
      }
    });
    console.log("protected clusters:", JSON.stringify(
      sortedClusters.map((c, i) => ({ rgb: c.rgb, pop: c.population, prot: !!c.protected, thread: palette[clusterDesignatedThreads[i]].hex }))
        .filter(x => x.prot)
    ));
    CHART_DIAG.protectedThreads = sortedClusters
      .map((c, i) => ({ rgb: c.rgb, pop: c.population, prot: !!c.protected, thread: palette[clusterDesignatedThreads[i]].hex }))
      .filter((x) => x.prot);
    // Cluster centroids for nearest-centroid lookup during pixel assignment.
    const clusterCentroidsRgb: Rgb[] = clusterColours;
    if (!allowed.size) allowed.add(nearestPaletteIndex([255, 255, 255], palRgb));
    const allowedIndexes = [...allowed];
    const allowedRgb = allowedIndexes.map((i) => palRgb[i]);

    // Map every output grid cell to a thread colour using majority-vote from
    // the full-resolution source image. For each cell, every source pixel in
    // the corresponding area votes for the nearest allowed thread; the thread
    // with the most votes wins. This produces clean solid fills and smooth
    // staircase outlines: a dark green glass wall covering 70% of a box
    // always wins cleanly, with no blending or ambiguity at boundaries.
    const idxArr = new Uint16Array(total);
    const usage = new Map<number, number>();
    const bgThreadIdx = allowedIndexes[nearestRgbIndex([255, 255, 255], allowedRgb)];
    const cellWhitePct = new Float32Array(total);
    const cellAllVotes = new Array<Map<number,number>>(gridW * gridH);

    // BFS flood fill from the source image border: marks every near-white
    // source pixel that is reachable from the image edge via white-only
    // neighbours as "canvas background". Interior white pixels (salt beads,
    // pith lines) are enclosed by dark pixels and are NOT reachable — so
    // they are correctly identified as genuine feature white without any
    // heuristic threshold on pixSum or cell context.
    const isCanvasBg = new Uint8Array(srcW * srcH);
    {
      const ffVis = new Uint8Array(srcW * srcH);
      const ffQ: number[] = [];
      for (let sy = 0; sy < srcH; sy++) {
        for (let sx = 0; sx < srcW; sx++) {
          if (sy > 0 && sy < srcH - 1 && sx > 0 && sx < srcW - 1) continue;
          const soff = (sy * srcW + sx) * 3;
          if (srcPixelRgb[soff] + srcPixelRgb[soff + 1] + srcPixelRgb[soff + 2] > 600) {
            const idx = sy * srcW + sx;
            if (!ffVis[idx]) { ffVis[idx] = 1; ffQ.push(idx); }
          }
        }
      }
      let qi = 0;
      while (qi < ffQ.length) {
        const pos = ffQ[qi++];
        isCanvasBg[pos] = 1;
        const fy = (pos / srcW) | 0, fx = pos % srcW;
        for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const ny = fy + dy, nx = fx + dx;
          if (ny < 0 || ny >= srcH || nx < 0 || nx >= srcW) continue;
          const npos = ny * srcW + nx;
          if (ffVis[npos]) continue;
          const noff = npos * 3;
          if (srcPixelRgb[noff] + srcPixelRgb[noff + 1] + srcPixelRgb[noff + 2] > 600) {
            ffVis[npos] = 1; ffQ.push(npos);
          }
        }
      }
    }
    // Mirror-symmetric sampling boundaries (audit A2c). Built once, then
    // forced to satisfy b[n-k] === len - b[k] exactly, so cell k and its
    // mirror partner always sample mirror-image pixel windows. Monotonic
    // and exactly covering by construction. The only residual asymmetry is
    // the centre pair when the cell count is even and the source dimension
    // is odd -- an odd pixel cannot be split between two cells, so that one
    // is geometric, not algorithmic.
    const symmetricBounds = (cells: number, len: number): Int32Array => {
      const b = new Int32Array(cells + 1);
      for (let k = 0; k <= cells; k++) b[k] = Math.floor((k * len) / cells);
      for (let k = 0; k <= cells; k++) if (k < cells - k) b[cells - k] = len - b[k];
      return b;
    };
    const colBound = symmetricBounds(rw, srcW);
    const rowBound = symmetricBounds(rh, srcH);
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const outputIdx = gy * gridW + gx;
        // Padding area (outside the centred source image) — assign to background.
        if (gx < ox || gx >= ox + rw || gy < oy || gy >= oy + rh) {
          idxArr[outputIdx] = bgThreadIdx;
          usage.set(bgThreadIdx, (usage.get(bgThreadIdx) ?? 0) + 1);
          continue;
        }
        // Source image region corresponding to this output cell, read from
        // the mirror-symmetric boundary tables built above. The old inline
        // floor-partition gave a cell and its mirror partner windows one
        // pixel out of step (audit A2c: measured EVERY cell mismatched in
        // 9 of 10 realistic grid/source combinations).
        const sx0 = colBound[gx - ox];
        const sx1 = Math.max(sx0 + 1, colBound[gx - ox + 1]);
        const sy0 = rowBound[gy - oy];
        const sy1 = Math.max(sy0 + 1, rowBound[gy - oy + 1]);
        // Single pass over source pixels: tally thread votes, count white
        // pixels (for salt/pith overlay) and dark pixels (for outline
        // boundary preservation), all in one loop for efficiency.
        const tally = new Map<number, number>();
        const darkTally = new Map<number, number>();
        let interiorWhite = 0, offWhite = 0, darkPixels = 0, totalPixels = 0;
        for (let sy = sy0; sy < Math.min(sy1, srcH); sy++) {
          for (let sx = sx0; sx < Math.min(sx1, srcW); sx++) {
            const off = (sy * srcW + sx) * 3;
            const sr = srcPixelRgb[off], sg = srcPixelRgb[off + 1], sb = srcPixelRgb[off + 2];
            // Map source pixel → nearest CLUSTER CENTROID → that cluster's
            // designated thread. This guarantees darker-liquid pixels vote
            // for the darker-liquid thread (not the dominant liquid thread),
            // so minority shades survive into the final palette.
            let voteThread: number;
            if (isPlainWhite(sr, sg, sb, whiteFloor)) {
              voteThread = bgThreadIdx;
            } else {
              const ci = nearestRgbIndex([sr, sg, sb] as Rgb, clusterCentroidsRgb);
              voteThread = clusterDesignatedThreads[ci];
            }
            const srcPixIdx = sy * srcW + sx;
            const voteWeight = thinLineMap[srcPixIdx] === 1 ? THIN_LINE_VOTE_WEIGHT : 1;
            tally.set(voteThread, (tally.get(voteThread) ?? 0) + voteWeight);
            const pixSum = sr + sg + sb;
            // interiorWhite: enclosed by dark pixels — not reachable from
            // border by BFS. Catches pith lines reliably.
            // offWhite: slightly off-white (not pure #FFFFFF) — catches
            // salt beads when the generator renders them as cream/off-white
            // rather than pure white. Used as fallback when interior is 0.
            const srcPos = srcPixIdx;
            if (pixSum > 680 && !isCanvasBg[srcPos]) interiorWhite += voteWeight;
            if (pixSum > 680 && pixSum < 756) offWhite += voteWeight;
            // Dark pixel: dark design colour — glass wall, stem, lime rind
            // (sum < 350 catches dark green [10,100,54]=164 and lime rind
            // [102,154,54]=310 without catching olive liquid [193,214,101]=508)
            if (pixSum < 350) {
              darkPixels += voteWeight;
              darkTally.set(voteThread, (darkTally.get(voteThread) ?? 0) + voteWeight);
            }
            totalPixels += voteWeight;
          }
        }

        // Majority vote.
        let bestThread = bgThreadIdx, bestN = 0;
        for (const [thread, count] of tally) {
          if (count > bestN) { bestN = count; bestThread = thread; }
        }
        cellAllVotes[outputIdx] = new Map(tally);

        // Dark-outline boundary preservation: if majority voted for background
        // but ≥8% of source pixels are dark design colours (glass wall pixels
        // or lime rind pixels at the curved boundary), override to the most
        // common dark thread. This closes gaps in outlines at curved edges
        // where the glass wall only covers ~10-30% of the boundary cell.
        // Track when this fires — white pixels in these cells are canvas
        // Dark-outline boundary preservation: majority background but ≥5%
        // dark pixels → override to the most common dark thread.
        if (bestThread === bgThreadIdx && totalPixels > 0 && darkPixels / totalPixels >= 0.05) {
          let darkBest = bgThreadIdx, darkBestN = 0;
          for (const [thread, count] of darkTally) {
            if (count > darkBestN) { darkBestN = count; darkBest = thread; }
          }
          if (darkBest !== bgThreadIdx) bestThread = darkBest;
        }

        // White-feature overlay (first pass — dark-majority cells only).
        // whitePixels now counts only interior white (salt beads, pith lines)
        // as determined by the pre-computed BFS flood fill — canvas background
        // pixels are excluded regardless of whether this is a boundary cell.
        {
          const [mt_r, mt_g, mt_b] = palRgb[bestThread];
          const effectiveWhite = Math.max(interiorWhite, offWhite);
          if (!isPlainWhite(mt_r, mt_g, mt_b, 220) && (mt_r + mt_g + mt_b) < 350 && totalPixels > 0 && effectiveWhite / totalPixels >= 0.22) {
            const nearWhite: Rgb = [235, 237, 235];
            let nwThread = bgThreadIdx;
            {
              let _bestD = Infinity;
              const _target = rgbToLab(235, 237, 235);
              for (let _i = 0; _i < allowedIndexes.length; _i++) {
                if (allowedIndexes[_i] === bgThreadIdx) continue;
                const _d = labDistSq(rgbToLab(allowedRgb[_i][0], allowedRgb[_i][1], allowedRgb[_i][2]), _target);
                if (_d < _bestD) { _bestD = _d; nwThread = allowedIndexes[_i]; }
              }
            }
            const [nw_r, nw_g, nw_b] = palRgb[nwThread];
            if (rgbToLab(nw_r, nw_g, nw_b)[0] >= 85) bestThread = nwThread;
          }
        }

        // Cache white fraction for second-pass pith detection.
        cellWhitePct[outputIdx] = totalPixels > 0 ? Math.max(interiorWhite, offWhite) / totalPixels : 0;

        idxArr[outputIdx] = bestThread;
        usage.set(bestThread, (usage.get(bestThread) ?? 0) + 1);
      }
    }




    // A reserved (dark-neutral / vivid) cluster's thread must reach the output
    // palette EVEN AT ZERO USAGE. At coarse mesh a sub-stitch black stroke
    // averages to mid-grey in every cell, so nothing votes for the black
    // thread -- but the line-segment stamper further down is precisely what
    // puts those stitches back, and it can only map to a thread that survived
    // into outPalette. Dropping it here made that stamper inert: it looked up
    // its thread, found it missing from oldToNew, and skipped every black
    // segment. Measured on a real 126x126 chart: Charcoal #2F3136 was
    // correctly chosen for the reserved cluster, held 0 cells, was dropped
    // here, and the finished chart contained no black at all.
    for (const t of protectedThreadIdx) if (!usage.has(t)) usage.set(t, 0);
    // Reduce to <= effectiveMaxColours by remapping rarest -> nearest of kept
    let kept = [...usage.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    if (kept.length > effectiveMaxColours) {
      const keep = new Set(kept.slice(0, effectiveMaxColours));
      // Zero-usage protected threads sort last and would be cut by the slice.
      for (const t of protectedThreadIdx) keep.add(t);

      const palLabs = getLabs(palRgb);
      const remap = new Map<number, number>();
      for (const old of kept) {
        if (keep.has(old)) { remap.set(old, old); continue; }
        let best = -1, bestD = Infinity;
        for (const k of keep) {
          const d = labDistSq(palLabs[old], palLabs[k]);
          if (d < bestD) { bestD = d; best = k; }
        }
        remap.set(old, best);
      }
      usage.clear();
      for (let i = 0; i < total; i++) {
        const nv = remap.get(idxArr[i])!;
        idxArr[i] = nv;
        usage.set(nv, (usage.get(nv) ?? 0) + 1);
      }
      // usage was just rebuilt from cells, which drops zero-usage protected
      // threads again -- re-assert them for the same reason as above.
      for (const t of protectedThreadIdx) if (!usage.has(t)) usage.set(t, 0);
      kept = [...usage.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    }

    // Build output palette (only used colours)
    const oldToNew = new Map<number, number>();
    const outPalette = kept.map((oldIdx, newIdx) => {
      oldToNew.set(oldIdx, newIdx);
      const p = palette[oldIdx];
      return { id: p.id, name: p.n, family: p.f, hex: p.hex };
    });
    console.log(
      "chart palette: effectiveMaxColours=", effectiveMaxColours,
      "clusterCount=", clusterCount,
      "palette=", outPalette.map((p) => `${p.id}:${p.hex}`).join(","),
    );
    const outUsage: Record<string, number> = {};
    for (const [oldIdx, count] of usage) {
      outUsage[String(oldToNew.get(oldIdx))] = count;
    }
    const outlineProtectedIndices = findOutlineProtectedIndices(outPalette, outUsage, total);
    if (outlineProtectedIndices.size) {
      console.log("outlineProtectedIndices", [...outlineProtectedIndices].map((i) => ({
        index: i,
        id: outPalette[i].id,
        hex: outPalette[i].hex,
        population: outUsage[String(i)],
      })));
    }
    // Outline protection is computed against the palette as it stands NOW,
    // but the three compaction passes below (two merges and a cull) each
    // COMPACT the palette afterward, shifting every index above an absorbed
    // entry. Without remapping, outlineProtectedIndices ends up pointing at
    // different colours (or past the end of the palette) by the time
    // despeckleGrid/cleanConfetti consume it -- protecting whatever now sits
    // at those slots and leaving the real outlines unprotected. Each pass
    // returns an oldToSurvivor map for exactly this; apply it after each one.
    const remapProtected = (set: Set<number>, oldToSurvivor: number[]) => {
      const next = new Set<number>();
      for (const i of set) {
        const m = oldToSurvivor[i];
        if (m !== undefined && m >= 0) next.add(m);
      }
      set.clear();
      for (const v of next) set.add(v);
    };
    // symbols by new index
    const symMap: Record<string, string> = {};
    outPalette.forEach((_, i) => { symMap[String(i)] = SYMBOLS[i % SYMBOLS.length]; });

    // sections grouped by family
    const sectionMap = new Map<string, number[]>();
    outPalette.forEach((p, i) => {
      const list = sectionMap.get(p.family) ?? [];
      list.push(i);
      sectionMap.set(p.family, list);
    });
    const sections = [...sectionMap.entries()].map(([name, paletteIndexes]) => ({
      name,
      paletteIndexes,
    }));

    // remap idxArr to new indices and RLE encode
    const remapped = new Uint16Array(total);
    for (let i = 0; i < total; i++) remapped[i] = oldToNew.get(idxArr[i])!;

    // Near-duplicate palette merge pre-pass.
    // Collapses palette entries that are numerically near-identical AND
    // hold a trivially-small minority share of their pair (quantization
    // noise like the 43-cell #46423D speckle across the 1238-cell #32363D
    // roof, or the 2-cell #D35C52 stray inside the 2032-cell #C93C2F
    // facade). Runs BEFORE structural passes so frame/divider detection
    // sees a clean palette, and BEFORE the pith overlay so nwCandThread
    // resolution runs against the collapsed palette. Sits at the correct
    // pipeline layer: the outPalette entries here are already the picked
    // DMC/Appletons threads, so merging near-duplicates fuses the small
    // number of redundant thread picks made by quantization rather than
    // altering thread-matching itself. See palette-merge.ts for calibration.
    {
      // Near-white consolidation, FIRST, before the general merge below.
      // The bgProtected set below deliberately protects every near-white
      // entry from merging so a structural near-white (window frame,
      // glazing bar) can never be absorbed into the background thread
      // (28.2). That protection is correct against NON-white colours, but
      // it also blocks two near-whites from merging with EACH OTHER --
      // which is how a palette spends three slots on one perceptual colour.
      // Measured on a real upload: #FCFCFC / #EBEBE9 / #EBE5DF, mutually
      // dE00 3.26 / 3.70 / 5.86 -- at or barely above the 2.3 JND, i.e.
      // threads a stitcher cannot tell apart -- took 3 of 9 slots while
      // genuine black ink got none, and speckled pale areas with off-white
      // confetti instead of reading as one clean colour.
      //
      // Ceiling 5.0 is deliberately well below the house fixture's 9.03
      // white/cream pair (a real distinction that must survive) -- a 1.8x
      // margin. Inverting the protection set restricts this pass to
      // white-vs-white pairs only; no non-white entry is a candidate.
      {
        // Candidates for this pass: near-white entries ONLY, and never the
        // background thread itself. Excluding only non-whites (as this first
        // shipped) let a structural near-white -- the white radish tips -- be
        // absorbed into the canvas background, which both erases the detail
        // and makes it impossible to recolour the background without the
        // tips moving with it. Two NON-background near-whites may still merge
        // with each other, which is all the original defect required.
        const nonWhite = new Set<number>();
        let bgIdx = -1, bgBright = -1;
        for (let i = 0; i < outPalette.length; i++) {
          const [r, g, b] = hexToRgb(outPalette[i].hex);
          if (!isPlainWhite(r, g, b, 230)) { nonWhite.add(i); continue; }
          const bright = r + g + b;
          if (bright > bgBright) { bgBright = bright; bgIdx = i; }
        }
        if (bgIdx >= 0) nonWhite.add(bgIdx);
        const whiteMerge = mergeNearDuplicatePaletteEntries(
          remapped, outPalette, outUsage, symMap, sections, oldToNew,
          { protectedIndices: nonWhite, deCeiling: 5.0, ignoreMinorityShare: true },
        );
        remapProtected(outlineProtectedIndices, whiteMerge.oldToSurvivor);
        if (whiteMerge.merged) {
          console.log("near-white consolidation:", JSON.stringify({
            merges: whiteMerge.merges.map((m) => ({ dE: Math.round(m.dE * 100) / 100 })),
            palettePost: outPalette.map((p, i) => `${p.hex}(${outUsage[String(i)] ?? 0})`),
          }));
        }
      }

      // Protect the background (plain-white) thread from absorbing structural
      // near-white colours: background population is canvas area, not paint
      // coverage, so structural whites always look like a trivial minority.
      const bgProtected = new Set<number>();
      for (let i = 0; i < outPalette.length; i++) {
        const [r, g, b] = hexToRgb(outPalette[i].hex);
        if (isPlainWhite(r, g, b, 230) || protectedThreadHexes.has(outPalette[i].hex)) bgProtected.add(i);
      }
      const mergeReport = mergeNearDuplicatePaletteEntries(
        remapped, outPalette, outUsage, symMap, sections, oldToNew,
        { protectedIndices: bgProtected },
      );
      remapProtected(outlineProtectedIndices, mergeReport.oldToSurvivor);
      // Flat art only. Median-cut splits single design colours into several
      // near-identical entries when the budget exceeds the artwork's real
      // colour count -- both halves keep substantial population, so the
      // first pass's minority-share gate cannot catch them. Tight 7.0
      // ceiling: must stay below the house fixture's 9.03 white/cream pair,
      // which is a genuine distinction and must survive.
      if (inputType !== "photo") {
        // Recompute protection against the POST-first-pass palette: indices
        // shifted when entries were absorbed and compacted.
        const bgProtected2 = new Set<number>();
        for (let i = 0; i < outPalette.length; i++) {
          const [r, g, b] = hexToRgb(outPalette[i].hex);
          if (isPlainWhite(r, g, b, 230) || protectedThreadHexes.has(outPalette[i].hex)) bgProtected2.add(i);
        }
        const splitMerge = mergeNearDuplicatePaletteEntries(
          remapped, outPalette, outUsage, symMap, sections, oldToNew,
          {
            protectedIndices: bgProtected2, deCeiling: 7.0, ignoreMinorityShare: true,
            // Audit A3: without population gating, this pass merged ANY two
            // design colours within dE 7. Require spatial interleaving too,
            // so a median-cut split (speckled together) still merges but two
            // genuinely different close colours in separate regions do not.
            spatialGate: { gridW, gridH, minInterleave: 0.35 },
          },
        );
        remapProtected(outlineProtectedIndices, splitMerge.oldToSurvivor);
        console.log("flat-art split-colour merge:", JSON.stringify({
          merged: splitMerge.merged,
          merges: splitMerge.merges.map((m) => ({
            survivorHex: outPalette[splitMerge.oldToSurvivor[m.survivor]]?.hex ?? "(gone)",
            dE: Math.round(m.dE * 100) / 100,
            minFrac: Math.round(m.minFrac * 10000) / 10000,
          })),
          palettePost: outPalette.map((p, i) => `${p.id}:${p.hex}(${outUsage[String(i)] ?? 0})`),
        }));
      }

      if (mergeReport.merged) {
        console.log("palette-merge:", JSON.stringify({
          merges: mergeReport.merges.map((m) => ({
            absorbedHex: outPalette[mergeReport.oldToSurvivor[m.absorbed]]?.hex ?? "(gone)",
            survivorHex: outPalette[mergeReport.oldToSurvivor[m.survivor]]?.hex ?? "(gone)",
            dE: Math.round(m.dE * 100) / 100,
            minFrac: Math.round(m.minFrac * 10000) / 10000,
          })),
          palettePost: outPalette.map((p) => `${p.id}:${p.hex}(${outUsage[String(outPalette.indexOf(p))] ?? 0})`),
        }));
      }

      // Unstitchable-remnant cull. A colour used for a handful of stitches is
      // noise, not design -- it adds a thread to the shopping list that nobody
      // would buy. Distance-gated merges cannot remove these (a stray brown is
      // colour-distant from everything), so this is deliberately distance-blind
      // and usage-gated instead. Runs last, after the near-duplicate passes.
      {
        const totalStitches = Object.values(outUsage).reduce((a, b) => a + b, 0);
        const REMNANT_FLOOR = Math.max(10, Math.round(totalStitches * 0.0008));
        // Recompute protection against the CURRENT palette: indices shifted
        // when earlier passes absorbed and compacted entries.
        const bgProtected3 = new Set<number>();
        for (let i = 0; i < outPalette.length; i++) {
          const [r, g, b] = hexToRgb(outPalette[i].hex);
          if (isPlainWhite(r, g, b, 230) || protectedThreadHexes.has(outPalette[i].hex)) bgProtected3.add(i);
        }
        const cullReport = cullTinyEntries(
          remapped, outPalette, outUsage, symMap, sections, oldToNew,
          REMNANT_FLOOR, { protectedIndices: bgProtected3 },
        );
        remapProtected(outlineProtectedIndices, cullReport.oldToSurvivor);
        if (cullReport.culled) {
          console.log("remnant cull:", JSON.stringify({
            floor: REMNANT_FLOOR,
            culls: cullReport.culls.map((c) => ({
              usage: c.usage,
              dE: Math.round(c.dE * 100) / 100,
              survivorHex: outPalette[cullReport.oldToSurvivor[c.survivor]]?.hex ?? "(gone)",
            })),
            palettePost: outPalette.map((p, i) => `${p.id}:${p.hex}(${outUsage[String(i)] ?? 0})`),
          }));
        }
      }
    }


    // Second-pass pith overlay with cascade (runs on remapped, new palette indices).
    // Initial pass: light-majority cells with ≥1 dark 8-neighbour AND ≥12% interior/
    // off-white source pixels → pith. Cascade passes (up to 4): light cells adjacent
    // to already-marked pith with ≥8% white content → also pith, extending pith lines
    // inward toward the lime centre.
    let nwCandThreadOld: number | undefined;
    {
      const nwCandRgb: Rgb = [235, 237, 235];
      // Find nearest light thread to use for pith/salt, explicitly excluding
      // the background thread so we don't write "invisible" white-on-white stitches.
      const bgNewIdx = oldToNew.get(bgThreadIdx) ?? 0;
      let nwCandIdx = -1;
      let nwCandBestD = Infinity;
      const nwCandTarget = rgbToLab(235, 237, 235);
      for (let _i = 0; _i < allowedIndexes.length; _i++) {
        if (allowedIndexes[_i] === bgThreadIdx) continue; // skip background
        const d = labDistSq(rgbToLab(allowedRgb[_i][0], allowedRgb[_i][1], allowedRgb[_i][2]), nwCandTarget);
        if (d < nwCandBestD) { nwCandBestD = d; nwCandIdx = _i; }
      }
      nwCandThreadOld = nwCandIdx >= 0 ? allowedIndexes[nwCandIdx] : allowedIndexes[nearestRgbIndex(nwCandRgb, allowedRgb)];
      let nwCandThread: number;
      if (oldToNew.has(nwCandThreadOld)) {
        nwCandThread = oldToNew.get(nwCandThreadOld)!;
      } else {
        // Near-white thread was culled in the effectiveMaxColours reduction step.
        // Re-add it to the output palette so pith/salt stitches have a valid index.
        nwCandThread = outPalette.length;
        const p = palette[nwCandThreadOld];
        outPalette.push({ id: p.id, name: p.n, family: p.f, hex: p.hex });
        oldToNew.set(nwCandThreadOld, nwCandThread);
        outUsage[String(nwCandThread)] = 0;
        symMap[String(nwCandThread)] = SYMBOLS[nwCandThread % SYMBOLS.length];
        const fam = p.f;
        let sec = sections.find(s => s.name === fam);
        if (!sec) { sec = { name: fam, paletteIndexes: [] }; sections.push(sec); }
        sec.paletteIndexes.push(nwCandThread);
      }
      const nwEntry = outPalette[nwCandThread];
      const [nwc_r, nwc_g, nwc_b] = hexToRgb(nwEntry.hex);
      const nwcLab = rgbToLab(nwc_r, nwc_g, nwc_b);
      console.log("pith nwCandThread resolved:", { id: nwEntry.id, hex: nwEntry.hex, labL: Math.round(nwcLab[0]), nwCandThreadOld, allowedIndexesConsidered: allowedIndexes.filter((i) => i !== bgThreadIdx).map((i) => palette[i].id) });
      if (nwcLab[0] >= 85) {
        let initialPithCount = 0;
        // Initial pass
        for (let gy = 0; gy < gridH; gy++) {
          for (let gx = 0; gx < gridW; gx++) {
            if (gx < ox || gx >= ox + rw || gy < oy || gy >= oy + rh) continue;
            const outputIdx = gy * gridW + gx;
            const ctNew = remapped[outputIdx];
            const [ct_r, ct_g, ct_b] = hexToRgb(outPalette[ctNew].hex);
            if (isPlainWhite(ct_r, ct_g, ct_b, 220)) continue;
            if ((ct_r + ct_g + ct_b) < 350) continue;
            if (cellWhitePct[outputIdx] < 0.12) continue;
            let darkN = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nr = gy + dy, nc = gx + dx;
                if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
                const [nr2, ng2, nb2] = hexToRgb(outPalette[remapped[nr * gridW + nc]].hex);
                if ((nr2 + ng2 + nb2) < 350) darkN++;
              }
            }
            if (darkN >= 1) {
              outUsage[String(ctNew)] = Math.max(0, (outUsage[String(ctNew)] ?? 0) - 1);
              remapped[outputIdx] = nwCandThread;
              outUsage[String(nwCandThread)] = (outUsage[String(nwCandThread)] ?? 0) + 1;
              initialPithCount++;
            }
          }
        }
        console.log("pith initial pass stamped cells:", initialPithCount);
        // Cascade passes
        for (let pass = 0; pass < 4; pass++) {
          let anyAdded = false;
          for (let gy = 0; gy < gridH; gy++) {
            for (let gx = 0; gx < gridW; gx++) {
              if (gx < ox || gx >= ox + rw || gy < oy || gy >= oy + rh) continue;
              const outputIdx = gy * gridW + gx;
              if (remapped[outputIdx] === nwCandThread) continue;
              const ctNew = remapped[outputIdx];
              const [ct_r, ct_g, ct_b] = hexToRgb(outPalette[ctNew].hex);
              if (isPlainWhite(ct_r, ct_g, ct_b, 220)) continue;
              if ((ct_r + ct_g + ct_b) < 350) continue;
              if (cellWhitePct[outputIdx] < 0.08) continue;
              let pithN = 0;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  const nr = gy + dy, nc = gx + dx;
                  if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
                  if (remapped[nr * gridW + nc] === nwCandThread) pithN++;
                }
              }
              if (pithN >= 1) {
                outUsage[String(ctNew)] = Math.max(0, (outUsage[String(ctNew)] ?? 0) - 1);
                remapped[outputIdx] = nwCandThread;
                outUsage[String(nwCandThread)] = (outUsage[String(nwCandThread)] ?? 0) + 1;
                anyAdded = true;
              }
            }
          }
          if (!anyAdded) break;
        }
      }
    }

    // Stamp detected line segments onto the grid as complete units.
    // Runs after pith overlay so structural cream lines (glazing bars,
    // door surrounds) are not overwritten by the pith cascade. Segments are
    // pre-filtered in detectLineSegments to only include elongated (line-shaped)
    // detections, so it's safe to let them correct any underlying cell —
    // noise blobs never reach this loop in the first place.
    // segmentStampedCells tracks every cell touched by a segment so later
    // cleanup passes (confetti, despeckle) never treat them as noise
    // candidates. This matters at crossing points (e.g. a window's
    // horizontal glazing bar crossing the vertical one) — the crossing
    // splits a stamped run into shorter pieces that could otherwise fall
    // under the confetti/run-length protection threshold and get dissolved
    // into the surrounding fill, even though they're known-real structural
    // stitches, not inferred ones.
    const segmentStampedCells = new Set<number>();
    // Hoisted out of the stamping block so the final phantom-entry sweep can
    // protect segment-admitted threads.
    const segmentAdmittedHexes = new Set<string>();
    {
      const bgThreadIdxSet = new Set<number>();
      for (let i = 0; i < outPalette.length; i++) {
        const [r, g, b] = hexToRgb(outPalette[i].hex);
        if (isPlainWhite(r, g, b, 230)) bgThreadIdxSet.add(i);
      }

      // Caps on segment-admitted threads. Deliberately small: this is a
      // safety valve for linework the fill-oriented derivation cannot see,
      // not a second palette budget.
      const SEGMENT_ADMIT_DE = 12;        // an existing thread this close serves instead
      const SEGMENT_ADMIT_MAX = 4;        // hard cap on newly admitted threads
      const SEGMENT_ADMIT_MIN_CELLS = 3;  // ignore 1-2 cell specks
      let segmentAdmitted = 0;
      for (const seg of lineSegments) {

        // Use the shared cluster colour (from Fix 1) instead of this
        // segment's individual colour, so all segments in the same visual
        // cluster get the exact same thread.
        const clusterColour = (seg as any).clusterRef?.rgb ?? seg.colour;
        // Scope restriction: only light/near-white segments may stamp.
        // This is the segment system's original purpose (cream glazing bars,
        // window frames, door surrounds, pith lines) and keeps it from ever
        // touching dark/saturated fills (roof, chimney, door, bowl) — which
        // is where bleed and asymmetry have come from in every prior round.
        // Light segments (cream glazing bars, window frames, pith lines):
        // unchanged, stamp as before. Dark segments were previously rejected
        // outright here, which is why thin BLACK and DARK GREEN strokes could
        // never be restored after the resize averaged them into the paper.
        // A dark segment is now allowed, but only onto cells that are much
        // lighter than it -- which is exactly the "my stroke vanished into the
        // background" case, and never the "dark line beside a dark fill" case
        // the original gate was protecting against.
        const clusterPixSum = clusterColour[0] + clusterColour[1] + clusterColour[2];
        const isDarkSegment = clusterPixSum <= 600;
        const segThreadOld = nearestPaletteIndex(clusterColour, palRgb);
        if (isDarkSegment) {
          const darkSegDiag = {
            clusterColour, pixSum: clusterPixSum,
            wantThread: palette[segThreadOld].hex,
            inAllowed: allowed.has(segThreadOld),
            inOldToNew: oldToNew.get(segThreadOld) !== undefined,
            cells: seg.outputCells.size,
          };
          console.log("darkSeg:", JSON.stringify(darkSegDiag));
          CHART_DIAG.darkSegments.push(darkSegDiag);
        }
        // NOTE: there is deliberately NO `allowed.has(segThreadOld)` gate here.
        // `allowed` only contains threads that palette derivation produced, and
        // derivation is structurally blind to linework (it samples flat regions
        // of the denoised source; a thin stroke has no flat interior). Gating on
        // `allowed` is exactly what discarded all 304 dark segments in the live
        // capture. Admission is instead bounded by the SEGMENT_ADMIT_* caps
        // below, which is a real limit on palette growth rather than a rule that
        // silently deletes the linework.
        // A detected line segment is direct evidence of a real design colour:
        // it was found on the UN-denoised source at full resolution, where the
        // ink is unambiguous. Palette derivation cannot see it, because it
        // samples only flat regions (3x3 range <= 8) of the DENOISED source --
        // and thin linework has essentially no flat interior. That is a
        // structural blind spot, not a tuning problem: measured live, 304 dark
        // segments were detected while reserveDarkNeutrals reported null,
        // because the black ink never reached the sample set to be reserved
        // from. Dropping the segment here is what erased every black stroke.
        //
        // So: if the segment's ideal thread is not already in the palette,
        // admit it -- but only when no existing entry is perceptually close
        // enough to serve, and only a few times, so this can never become an
        // uncapped palette leak.
        let segThread = oldToNew.get(segThreadOld);
        if (segThread === undefined) {
          let nearestIdx = -1, nearestDE = Infinity;
          const segLab = rgbToLab(clusterColour[0], clusterColour[1], clusterColour[2]);
          for (let i = 0; i < outPalette.length; i++) {
            const [pr, pg, pb] = hexToRgb(outPalette[i].hex);
            const dE = ciede2000(segLab, rgbToLab(pr, pg, pb));
            if (dE < nearestDE) { nearestDE = dE; nearestIdx = i; }
          }
          if (nearestDE <= SEGMENT_ADMIT_DE) {
            // An existing thread already represents this colour well enough.
            segThread = nearestIdx;
          } else if (segmentAdmitted < SEGMENT_ADMIT_MAX && seg.outputCells.size >= SEGMENT_ADMIT_MIN_CELLS) {
            const p = palette[segThreadOld];
            const newIdx = outPalette.length;
            outPalette.push({ id: p.id, name: p.n, family: p.f, hex: p.hex });
            oldToNew.set(segThreadOld, newIdx);
            let sec = sections.find((s) => s.name === p.f);
            if (!sec) { sec = { name: p.f, paletteIndexes: [] }; sections.push(sec); }
            sec.paletteIndexes.push(newIdx);
            outUsage[String(newIdx)] = 0;
            segmentAdmitted++;
            segmentAdmittedHexes.add(p.hex);
            segThread = newIdx;
            console.log("segment admitted thread:", JSON.stringify({ hex: p.hex, nearestDE: Math.round(nearestDE * 10) / 10, cells: seg.outputCells.size }));
          } else {
            continue;
          }
        }

        // Never stamp background colour as the segment's own colour
        if (bgThreadIdxSet.has(segThread)) continue;
        // First pass: stamp all cells and track which were actually changed.
        // Second pass: remove isolated stamped cells that have no stamped
        // neighbour — these are rogue skeleton pixels that mapped 1 cell
        // outside the actual feature region due to rounding at source edges.
        // Minimum lightness gap before a dark segment may overwrite a cell.
        // 150 (out of a 765 max) comfortably clears the real cases measured
        // on the failing chart -- a lost stroke sits on ground 390-440
        // lighter than the ink -- while a dark line running alongside a dark
        // fill differs by far less and is correctly left alone.
        const DARK_SEGMENT_MIN_CONTRAST = 150;
        const stampedThisSeg = new Set<number>();
        for (const cell of seg.outputCells) {
          const old = remapped[cell];
          if (old === segThread) { stampedThisSeg.add(cell); continue; }
          if (isDarkSegment) {
            const [oR, oG, oB] = hexToRgb(outPalette[old].hex);
            if ((oR + oG + oB) - clusterPixSum < DARK_SEGMENT_MIN_CONTRAST) continue;
          }
          outUsage[String(old)] = Math.max(0, (outUsage[String(old)] ?? 0) - 1);
          remapped[cell] = segThread;
          outUsage[String(segThread)] = (outUsage[String(segThread)] ?? 0) + 1;
          stampedThisSeg.add(cell);
        }
        // Trim isolated rogue cells: a stamped cell with no 4-connected
        // stamped neighbour is almost certainly a skeleton pixel that
        // drifted one cell outside the feature due to edge rounding.
        // Revert it to its prior majority-vote colour (background/navy/wall).
        for (const cell of stampedThisSeg) {
          const row = (cell / gridW) | 0;
          const col = cell % gridW;
          let hasStampedNeighbour = false;
          for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
            const nr = row + dr, nc = col + dc;
            if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
            if (stampedThisSeg.has(nr * gridW + nc)) { hasStampedNeighbour = true; break; }
          }
          if (!hasStampedNeighbour) {
            // Revert: restore the cell to what the majority vote put there.
            // Use the most common non-segment colour among 8 neighbours as
            // the revert target (same logic as confetti cleanup).
            const tally: Record<number, number> = {};
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nr = row + dy, nc = col + dx;
                if (nr < 0 || nr >= gridH || nc < 0 || nc >= gridW) continue;
                const nb = remapped[nr * gridW + nc];
                if (nb === segThread) continue;
                tally[nb] = (tally[nb] ?? 0) + 1;
              }
            }
            let revertTo = -1, revertN = 0;
            for (const k in tally) { if (tally[+k] > revertN) { revertN = tally[+k]; revertTo = +k; } }
            if (revertTo >= 0) {
              outUsage[String(segThread)] = Math.max(0, (outUsage[String(segThread)] ?? 0) - 1);
              outUsage[String(revertTo)] = (outUsage[String(revertTo)] ?? 0) + 1;
              remapped[cell] = revertTo;
              stampedThisSeg.delete(cell);
            }
          }
        }
        for (const cell of stampedThisSeg) segmentStampedCells.add(cell);
      }
      CHART_DIAG.segmentAdmitted = [...segmentAdmittedHexes];
      console.log("dark stamp summary:", JSON.stringify({

        paletteNow: outPalette.map((p, i) => `${p.hex}(${outUsage[String(i)] ?? 0})`),
      }));
      CHART_DIAG.paletteWithUsage = outPalette.map((p, i) => `${p.hex}(${outUsage[String(i)] ?? 0})`);
    }

    // Compute junction cells: any segment-stamped cell with stamped
    // neighbours in both a horizontal AND vertical direction is a line
    // intersection (e.g. a window's horizontal glazing bar crossing the
    // vertical one). These cells are structurally special — they belong to
    // two lines at once — and must never be trimmed, reverted, or shifted
    // by any downstream pass, or the crossing point develops a gap.
    const junctionCells = new Set<number>();
    for (const cell of segmentStampedCells) {
      const r = (cell / gridW) | 0, c = cell % gridW;
      const hasLeft = c > 0 && segmentStampedCells.has(cell - 1);
      const hasRight = c < gridW - 1 && segmentStampedCells.has(cell + 1);
      const hasUp = r > 0 && segmentStampedCells.has(cell - gridW);
      const hasDown = r < gridH - 1 && segmentStampedCells.has(cell + gridW);
      const hasHorizontal = hasLeft || hasRight;
      const hasVertical = hasUp || hasDown;
      if (hasHorizontal && hasVertical) junctionCells.add(cell);
    }
    console.log("junction cells detected:", junctionCells.size);

    // ---- PHASE 3 (LIVE): structural model renders frames directly. ----
    // Detects window/surround frames as objects, applies integer constraints
    // (pair congruence, parity snap, divider centring), and rasterises them
    // in one deterministic pass — replacing normaliseWindowFrameBorders,
    // enforcePairedRegionSymmetry and centreDividerLines (definitions kept
    // unreferenced for rollback). Free lines (pith, salt) are NOT rendered
    // by the model (renderFreeLines: false) — they stay with the existing
    // pith/segment machinery, which keeps organic motifs bit-identical.
    let structuralOwnedCells = new Set<number>();
    try {
      const structuralModel = runStructuralPass(
        remapped, gridW, gridH, outPalette, outUsage, segmentStampedCells,
        { renderFreeLines: false, canvasShape: shape },
      );
      structuralOwnedCells = structuralModel.ownedCells;
      console.log("structural model (LIVE):", JSON.stringify({
        frames: structuralModel.frames.map((f) => ({
          rect: [f.r0, f.c0, f.r1, f.c1],
          frameColour: f.frameColour,
          paneColour: f.paneColour,
          hDividers: f.hDividers,
          vDividers: f.vDividers,
          pairId: f.pairId,
        })),
        freeLines: structuralModel.freeLines.map((l) => ({ colour: l.colour, cells: l.cells.length })),
        ownedCells: structuralModel.ownedCells.size,
        outermostRegion: identifyOutermostRegion(remapped, gridW, gridH),
      }));
    } catch (e) {
      console.log("structural model (LIVE) ERROR — grid untouched by model:", String(e));
    }

    // Model-owned cells (rendered frames) are structural: every subsequent
    // cleanup/fill pass (despeckle, confetti, hole-fill, gap-bridge) must
    // never treat them as noise nor overwrite them. Union with segment-stamped cells.
    const structuralProtected = new Set(segmentStampedCells);
    for (const c of structuralOwnedCells) structuralProtected.add(c);

    // Confetti cleanup runs BEFORE border stamping, so deliberately-placed


    // border motifs are never dissolved as noise. Runs twice so stragglers
    // newly isolated by the first pass get caught too.
    let confettiRemoved = 0;
    let despeckled = 0;
    if (confettiMin > 0) {
      // Protect the near-white pith/salt thread from DESPECKLE only —
      // confetti cleanup relies on runProtectedPositions to shield real
      // pith/salt runs (≥2 stitches), while isolated lone stitches (e.g.
      // a stray D in the stem) should still be cleaned up by confetti.
      const nwProtectedForDespeckle = nwCandThreadOld !== undefined && oldToNew.has(nwCandThreadOld);
      if (nwProtectedForDespeckle) {
        outlineProtectedIndices.add(oldToNew.get(nwCandThreadOld!)!);
      }



      despeckled = despeckleGrid(remapped, gridW, gridH, outUsage, outlineProtectedIndices, structuralProtected);

      console.log("despeckled pixels:", despeckled);
      // Remove near-white thread protection before confetti — runProtectedPositions
      // will still shield real pith/salt runs, but isolated lone stitches can now
      // be cleaned up by confetti as intended.
      if (nwProtectedForDespeckle) {
        outlineProtectedIndices.delete(oldToNew.get(nwCandThreadOld!)!);
      }
      // Build run-length protection BEFORE confetti so continuous line
      // features (3+ stitches in H/V/diagonal) survive regardless of
      // region size — these are real design details, not noise.
      const runProtectedPositions = buildLinearRunProtection(remapped, gridW, gridH, 3);
      console.log("run-protected stitches:", runProtectedPositions.size, "segment-stamped stitches:", segmentStampedCells.size);
      // Merge segment-stamped cells into the protected-positions set so
      // short runs at line-crossing points (e.g. a window's horizontal bar
      // split by the vertical bar) are never dissolved as confetti.
      const allProtectedPositions = new Set(runProtectedPositions);
      for (const c of structuralProtected) allProtectedPositions.add(c);
      confettiRemoved += cleanConfetti(remapped, gridW, gridH, confettiMin, outUsage, outlineProtectedIndices, allProtectedPositions);
    }




    // Interior hole-fill: background pixels enclosed on 3+ sides (4-connectivity)
    // by non-background design stitches are fill gaps from the resize step, not
    // real canvas areas. Delegated to cleanup-passes.ts (adds border-reachable
    // background gating so deliberate open negative space is preserved).
    {
      const bgIds = new Set<number>();
      for (let i = 0; i < outPalette.length; i++) {
        const [r, g, b] = hexToRgb(outPalette[i].hex);
        if (isPlainWhite(r, g, b, 230)) bgIds.add(i);
      }
      const holesFilled = holeFill(remapped, gridW, gridH, outUsage, bgIds, structuralProtected);
      if (holesFilled > 0) console.log("interior holes filled:", holesFilled);
    }


    // Gap-bridge: 1-pixel gaps in axis-aligned linear runs are filled with the
    // surrounding colour. Delegated to cleanup-passes.ts (horizontal + vertical
    // only; diagonal pairs removed to avoid thickening staircase diagonals).
    {
      const bgIdsGap = new Set<number>();
      for (let i = 0; i < outPalette.length; i++) {
        const [r, g, b] = hexToRgb(outPalette[i].hex);
        if (isPlainWhite(r, g, b, 230)) bgIdsGap.add(i);
      }
      const gapBridged = gapBridge(remapped, gridW, gridH, outUsage, bgIdsGap, structuralProtected);
      if (gapBridged > 0) console.log("gap-bridged pixels:", gapBridged);
    }

    // Stem and base symmetry: enforce mirror symmetry for rows below the bowl
    // (the stem and base are symmetric structural elements). The bowl, garnish,
    // and any asymmetric design elements are left untouched.
    {
      const bgIdsym = new Set<number>();
      for (let i = 0; i < outPalette.length; i++) {
        const [r, g, b] = hexToRgb(outPalette[i].hex);
        if (isPlainWhite(r, g, b, 230)) bgIdsym.add(i);
      }
      const bgIdDefault = [...bgIdsym][0] ?? 0;

      // Per-row design extents
      const rowLeft = new Int16Array(gridH).fill(-1);
      const rowRight = new Int16Array(gridH).fill(-1);
      const colDensity = new Int32Array(gridW);
      for (let row = 0; row < gridH; row++) {
        for (let col = 0; col < gridW; col++) {
          if (!bgIdsym.has(remapped[row * gridW + col])) {
            if (rowLeft[row] === -1) rowLeft[row] = col;
            rowRight[row] = col;
            colDensity[col]++;
          }
        }
      }

      // Centre column: peak of 3-wide smoothed column density
      let centerCol = Math.round(gridW / 2);
      let bestDensity = -1;
      for (let col = 1; col < gridW - 1; col++) {
        const smoothed = colDensity[col - 1] + colDensity[col] + colDensity[col + 1];
        if (smoothed > bestDensity) { bestDensity = smoothed; centerCol = col; }
      }

      // Max bowl width in upper half
      let maxBowlWidth = 0;
      for (let row = 0; row < Math.floor(gridH / 2); row++) {
        if (rowLeft[row] !== -1) maxBowlWidth = Math.max(maxBowlWidth, rowRight[row] - rowLeft[row] + 1);
      }

      // Stem floor: first row below 45% height where width ≤ 35% of max bowl width
      let stemFloor = -1;
      for (let row = Math.floor(gridH * 0.45); row < gridH; row++) {
        const w = rowLeft[row] === -1 ? 0 : rowRight[row] - rowLeft[row] + 1;
        if (w > 0 && w <= maxBowlWidth * 0.35) { stemFloor = row; break; }
      }
      if (stemFloor === -1) stemFloor = Math.floor(gridH * 0.65);

      // Vessel-shape gate: this symmetry pass assumes a genuine stem/bowl
      // silhouette (bowl wide, stem narrow — a real width DROP at stemFloor).
      // A house or other architectural motif has roughly constant wall width
      // below the roofline, so there's no narrowing and this pass has no
      // valid axis to mirror around. Applying it anyway force-mirrors
      // unrelated regions (windows, chimney, base) across a meaningless
      // centre column. Require the width just below stemFloor to be a real
      // fraction of the max width — a genuine stem measures well under 35%;
      // constant-width silhouettes measure close to 100%.
      let widthAtStemFloor = 0;
      for (let row = stemFloor; row < Math.min(gridH, stemFloor + 5); row++) {
        const w = rowLeft[row] === -1 ? 0 : rowRight[row] - rowLeft[row] + 1;
        if (w > 0) widthAtStemFloor = Math.max(widthAtStemFloor, w);
      }
      const isVesselShape = maxBowlWidth > 0 && widthAtStemFloor > 0 && (widthAtStemFloor / maxBowlWidth) <= 0.4;
      console.log("stem symmetry vessel-shape check:", { maxBowlWidth, widthAtStemFloor, ratio: maxBowlWidth > 0 ? Math.round((widthAtStemFloor / maxBowlWidth) * 100) / 100 : null, isVesselShape });
      // Axis refinement + evidence gate: evaluate the seed axis and its two
      // half-column neighbours (axis2 = 2*axis, so odd axis2 = between
      // columns; the mirror of column c about axis2/2 is axis2 - c, an
      // integer for both cases). Enforce mirroring ONLY about the axis the
      // design already agrees with: symmetric-up-to-noise stems measure
      // near-1.0 agreement and get their noise repaired; a genuinely
      // asymmetric lower region (garnish, off-centre base) measures low and
      // is left untouched instead of gaining a phantom mirrored duplicate.
      const STEM_MIRROR_MIN_AGREEMENT = 0.85;
      let bestAxis2 = 2 * centerCol;
      let bestAgreement = -1;
      for (const axis2 of [2 * centerCol - 1, 2 * centerCol, 2 * centerCol + 1]) {
        let match = 0, considered = 0;
        for (let row = stemFloor; row < gridH; row++) {
          for (let lc = 0; 2 * lc < axis2; lc++) {
            const rc = axis2 - lc;
            if (rc >= gridW) continue;
            const lOn = !bgIdsym.has(remapped[row * gridW + lc]);
            const rOn = !bgIdsym.has(remapped[row * gridW + rc]);
            if (!lOn && !rOn) continue;
            considered++;
            if (lOn === rOn) match++;
          }
        }
        const agreement = considered > 0 ? match / considered : 0;
        if (agreement > bestAgreement) { bestAgreement = agreement; bestAxis2 = axis2; }
      }
      const hasMirrorEvidence = bestAgreement >= STEM_MIRROR_MIN_AGREEMENT;
      console.log("stem symmetry axis check:", { seedCol: centerCol, bestAxis2, bestAgreement: Math.round(bestAgreement * 100) / 100, hasMirrorEvidence });

      if (!isVesselShape || !hasMirrorEvidence) {
        // Not a vessel shape, or the region below the stem floor is not
        // already near-mirror-symmetric about any candidate axis — skip the
        // mirror pass entirely, leave the design exactly as the majority
        // vote / pith / segment stamp pipeline already resolved it.
      } else {


      // Mirror stem and base rows only
      // Identify all near-white palette indices by lightness — any thread with
      // Lab L* >= 85 is considered near-white (salt/pith thread) in this context.
      const nwIndices = new Set<number>();
      outPalette.forEach((p, i) => {
        const [pr, pg, pb] = hexToRgb(p.hex);
        if (rgbToLab(pr, pg, pb)[0] >= 85) nwIndices.add(i);
      });
      // Exclude the background itself from near-white set
      bgIdsym.forEach(i => nwIndices.delete(i));
      const maxHalf = Math.ceil(gridW / 4) + 2;
      for (let row = stemFloor; row < gridH; row++) {
        for (let lc = Math.max(0, Math.ceil(bestAxis2 / 2) - maxHalf); 2 * lc < bestAxis2; lc++) {
          const rc = bestAxis2 - lc;
          if (rc >= gridW) continue;
          const li = row * gridW + lc, ri = row * gridW + rc;
          const lv = remapped[li], rv = remapped[ri];
          if (lv === rv) continue;
          const lBg = bgIdsym.has(lv), rBg = bgIdsym.has(rv);
          if (!lBg && rBg) {
            // Left has design, right is background — mirror left to right
            remapped[ri] = lv;
            outUsage[String(bgIdDefault)] = Math.max(0, (outUsage[String(bgIdDefault)] ?? 0) - 1);
            outUsage[String(lv)] = (outUsage[String(lv)] ?? 0) + 1;
          } else if (lBg && !rBg) {
            // Right has design, left is background — mirror right to left
            remapped[li] = rv;
            outUsage[String(bgIdDefault)] = Math.max(0, (outUsage[String(bgIdDefault)] ?? 0) - 1);
            outUsage[String(rv)] = (outUsage[String(rv)] ?? 0) + 1;
          } else if (!lBg && !rBg && lv !== rv) {
            // Both sides have design pixels of different colours.
            // If either is the near-white pith/salt thread, replace with the other.
            // Otherwise leave both as-is — don't force conflicts in the stem.
            const lIsNw = nwIndices.has(lv), rIsNw = nwIndices.has(rv);
            if (lIsNw && !rIsNw) {
              remapped[li] = rv;
              outUsage[String(lv)] = Math.max(0, (outUsage[String(lv)] ?? 0) - 1);
              outUsage[String(rv)] = (outUsage[String(rv)] ?? 0) + 1;
            } else if (rIsNw && !lIsNw) {
              remapped[ri] = lv;
              outUsage[String(rv)] = Math.max(0, (outUsage[String(rv)] ?? 0) - 1);
              outUsage[String(lv)] = (outUsage[String(lv)] ?? 0) + 1;
            }
            // Both non-near-white and different — leave as-is
          }
        }
      }
      }
    }


    // Stamp border stitches directly onto the chart grid, using the user's
    // chosen flat thread colours. These stitches override any image pixel
    // underneath and are added to the palette/usage/sections so the colour
    // key and stitch counts reflect them.
    stampBorderOnGrid(
      remapped,
      gridW,
      gridH,
      border as BorderInput,
      palette,
      palRgb,
      outPalette,
      sections,
      outUsage,
      oldToNew,
      shape,
      finishedWidthInches,
      finishedHeightInches,
    );
    console.log("chart border applied:", (border as BorderInput)?.style ?? "none");

    // Assign symbols for any palette entries appended by the border stamp.
    outPalette.forEach((_, i) => {
      if (!symMap[String(i)]) symMap[String(i)] = SYMBOLS[i % SYMBOLS.length];
    });

    // Final phantom-entry sweep. Five cleanup passes since the last
    // compaction (despeckle, confetti, hole-fill, gap-bridge, stem/base
    // symmetry) can each independently zero out a colour's remaining
    // population -- none of them re-run compaction. floor=1 catches ONLY
    // genuinely-zero entries, so no real design colour (however small) is
    // ever at risk.
    {
      const bgProtectedFinal = new Set<number>();
      for (let i = 0; i < outPalette.length; i++) {
        const [r, g, b] = hexToRgb(outPalette[i].hex);
        if (isPlainWhite(r, g, b, 230) || segmentAdmittedHexes.has(outPalette[i].hex)) bgProtectedFinal.add(i);
      }
      const finalSweep = cullTinyEntries(
        remapped, outPalette, outUsage, symMap, sections, oldToNew,
        1, { protectedIndices: bgProtectedFinal },
      );
      if (finalSweep.culled) {
        console.log("final phantom-entry sweep:", JSON.stringify({
          removed: finalSweep.culls.map((c) => ({ usage: c.usage, dE: Math.round(c.dE * 100) / 100 })),
        }));
      }
    }





    const pixelsRLE: Array<[number, number]> = [];
    let runIdx = remapped[0], runLen = 1;
    for (let i = 1; i < total; i++) {
      if (remapped[i] === runIdx) { runLen++; }
      else { pixelsRLE.push([runIdx, runLen]); runIdx = remapped[i]; runLen = 1; }
    }
    pixelsRLE.push([runIdx, runLen]);

    // shading already applied above via posterisation + effectiveMaxColours.


    return new Response(
      JSON.stringify({
        width: gridW,
        height: gridH,
        palette: outPalette,
        symMap,
        usage: outUsage,
        sections,
        pixelsRLE,
        confettiRemoved,
        despeckled,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("chart error", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? "Unexpected error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
