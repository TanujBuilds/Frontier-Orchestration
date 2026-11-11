import {previewRoute} from './runtime.mjs';
export function registerRoutingTools({add,c,taskSchema}){
 add('routing_preview','Explain an approved worker route without probing, reserving or dispatching.',{goalId:{type:'string'},task:taskSchema},['goalId','task'],false,input=>previewRoute(c,input));
}
