import {NextResponse} from "next/server";
export const dynamic="force-dynamic";
export async function GET(){
 const services={twelveData:!!process.env.TWELVE_DATA_API_KEY,redis:!!(process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN),push:!!(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT),cronSecret:!!(process.env.DAGBO_CRON_SECRET||process.env.CRON_SECRET||process.env.SIGNAL_PUSH_SECURITY),ai:!!process.env.GROQ_API_KEY};
 const optional={fmpCalendar:!!process.env.FMP_API_KEY,publicCalendarFallback:true,googleOAuth:!!(process.env.DAGBO_GOOGLE_CLIENT_ID&&process.env.DAGBO_GOOGLE_CLIENT_SECRET)};
 const requiredReady=Object.values(services).every(Boolean);
 return NextResponse.json({ok:true,version:"0.3.0",services,optional,ready:requiredReady,note:"Configuration presence only; provider connectivity, calendar feed and scheduled delivery must be tested separately."});
}