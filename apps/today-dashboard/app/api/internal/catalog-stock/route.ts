import {timingSafeEqual} from 'node:crypto';
import {NextRequest,NextResponse} from 'next/server';
import {catalogStockIdentity,catalogStockReady,createCatalogStock} from '@/lib/server/masterCatalog';
export const dynamic='force-dynamic';
export const maxDuration=120;
function authorized(req:NextRequest){
 const expected=process.env.SLACK_OPS_SYNC_SECRET?.trim()||'';
 const header=req.headers.get('authorization')||'';
 const actual=header.startsWith('Bearer ')?header.slice(7).trim():'';
 const a=Buffer.from(actual),b=Buffer.from(expected);
 return Boolean(expected&&actual)&&a.length===b.length&&timingSafeEqual(a,b);
}
export async function GET(req:NextRequest){
 if(!authorized(req))return NextResponse.json({success:false,error:'인증 실패'},{status:401});
 try{return NextResponse.json({success:true,service:'catalog-stock',ready:catalogStockReady(),slack:await catalogStockIdentity()});}
 catch(error){return NextResponse.json({success:false,error:error instanceof Error?error.message:'서버 설정 확인 필요'},{status:503});}
}
export async function POST(req:NextRequest){
 if(!authorized(req))return NextResponse.json({success:false,error:'인증 실패'},{status:401});
 try{return NextResponse.json(await createCatalogStock(await req.json()));}
 catch(error){return NextResponse.json({success:false,error:error instanceof Error?error.message:'신규 장비 등록 확인 필요'},{status:400});}
}
