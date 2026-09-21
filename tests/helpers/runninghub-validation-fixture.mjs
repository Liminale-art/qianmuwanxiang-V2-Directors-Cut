import { bindComfyCloudProtocol } from '../../qianmu-comfy-cloud-protocol.js';
const node=(class_type,inputs)=>({class_type,inputs});
export const stillInput=()=>({connection:bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1'),
  workflow:{model:node('CheckpointLoaderSimple',{ckpt_name:'%qianmu_model%'}),
    pos:node('CLIPTextEncode',{text:'fixed style, %qianmu_prompt%',clip:['model',1]}),
    neg:node('CLIPTextEncode',{text:'%qianmu_negative%',clip:['model',1]}),
    latent:node('EmptyLatentImage',{width:'%qianmu_width%',height:512,batch_size:1}),
    sampler:node('KSampler',{seed:'%qianmu_seed%',model:['model',0],positive:['pos',0],negative:['neg',0],latent_image:['latent',0],steps:20,cfg:5,sampler_name:'euler',scheduler:'normal',denoise:1}),
    decode:node('VAEDecode',{samples:['sampler',0],vae:['model',2]}),save:node('SaveImage',{images:['decode',0],filename_prefix:'qianmu'})},
  prompt:'synthetic scene',negativePrompt:'synthetic exclusions',parameters:{width:512,seed:123},model:'fixture.safetensors',
  execution:{version:1,automatic:false,maxImages:1,outputNodeIds:['save'],allowUnverified:false}});
