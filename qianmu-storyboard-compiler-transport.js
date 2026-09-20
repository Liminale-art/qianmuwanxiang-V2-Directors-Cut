// Chosen-API adapter; diagnostics travel through existing response callbacks.
export async function callStoryboardCompiler(messages,profileId,requestOptions, {settings,normalizeStoryboardPromptFormats,callExternalApi,callSillyTavernModel}) {
  const matches=profileId?(settings.apiProfiles||[]).filter(item=>item.id===profileId):[];
  if(profileId&&matches.length!==1)throw new Error('取景 API 档案已失效或编号重复，请重新选择；未改用其他连接');
  const profile=matches[0]||null,source=requestOptions.temperature??profile?.temperature??0.35;
  const temperature=Number.isFinite(Number(source))?Number(source):0.35;
  const formats=requestOptions.promptFormats?.length?normalizeStoryboardPromptFormats(requestOptions.promptFormats).length:0;
  const focused=/^qianmu\.storyboard\.(narrative|expression)\.v1$/.test(requestOptions.jsonSchemaName||'');
  const maxTokens=Math.max(256,Math.min(formats||focused?16384:4000,Number(requestOptions.maxTokens)||2200));
  const callbacks={guard:requestOptions.guard,onResponse:requestOptions.onResponse};
  if(profile||settings.providerMode==='external')return callExternalApi(messages,null,{
    ...(profile?{apiUrl:profile.apiUrl,apiKey:profile.apiKey,model:profile.model}:{}),temperature,stream:false,maxTokens,
    structuredOutputMode:profile?profile.structuredOutputMode:settings.structuredOutputMode,
    jsonSchema:requestOptions.jsonSchema,jsonSchemaName:requestOptions.jsonSchemaName,jsonSchemaStrict:requestOptions.jsonSchemaStrict,...callbacks,
  },new AbortController());
  return callSillyTavernModel(messages.at(-1)?.content||'',messages[0]?.content||'',null,{stream_response:false,max_tokens:maxTokens,temperature,...callbacks});
}
