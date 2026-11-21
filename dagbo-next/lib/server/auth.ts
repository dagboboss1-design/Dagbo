import {createHmac,randomBytes,scryptSync,timingSafeEqual} from "node:crypto";
import {redisCommand} from "@/lib/server/redis";
export type DagboUser={email:string;username:string;name:string;googleSub?:string;passwordSalt?:string;passwordHash?:string;createdAt:string};
const USER_PREFIX="dagbo:auth:user:";
const SESSION_COOKIE="dagbo_session";
function secret(){const s=process.env.DAGBO_AUTH_SECRET;if(!s)throw new Error("DAGBO_AUTH_SECRET is not configured");return s;}
export function hashPassword(password:string,salt=randomBytes(16).toString("hex")){return {salt,hash:scryptSync(password,salt,64).toString("hex")};}
export function verifyPassword(password:string,user:DagboUser){if(!user.passwordSalt||!user.passwordHash)return false;const candidate=Buffer.from(scryptSync(password,user.passwordSalt,64).toString("hex"));const actual=Buffer.from(user.passwordHash);return candidate.length===actual.length&&timingSafeEqual(candidate,actual);}
export async function getUserByEmail(email:string){const raw=await redisCommand<string>("GET",USER_PREFIX+"email:"+email.toLowerCase());if(!raw)return null;return JSON.parse(raw) as DagboUser;}
export async function getUserByUsername(username:string){const email=await redisCommand<string>("GET",USER_PREFIX+"username:"+username.toLowerCase());return email?getUserByEmail(email):null;}
export async function createUser(user:DagboUser){const email=user.email.toLowerCase(),username=user.username.toLowerCase();const e=await redisCommand<string>("SET",USER_PREFIX+"email:"+email,JSON.stringify(user),"NX");if(e!=="OK")throw new Error("An account with this email already exists.");const u=await redisCommand<string>("SET",USER_PREFIX+"username:"+username,email,"NX");if(u!=="OK"){await redisCommand("DEL",USER_PREFIX+"email:"+email);throw new Error("That username is already taken.");}return user;}
export function sessionToken(user:DagboUser){const payload=Buffer.from(JSON.stringify({email:user.email,username:user.username,exp:Date.now()+30*86400000})).toString("base64url");const sig=createHmac("sha256",secret()).update(payload).digest("base64url");return payload+"."+sig;}
export function verifySession(token:string){try{const [payload,sig]=token.split(".");if(!payload||!sig)return null;const expected=createHmac("sha256",secret()).update(payload).digest();const got=Buffer.from(sig,"base64url");if(got.length!==expected.length||!timingSafeEqual(got,expected))return null;const data=JSON.parse(Buffer.from(payload,"base64url").toString());if(!data.email||data.exp<Date.now())return null;return data as {email:string;username:string;exp:number};}catch{return null;}}
export {SESSION_COOKIE};
