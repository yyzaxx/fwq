export function applySavedTemplate(form,preset){
  const category=String(form.category||'').trim();
  if(category&&preset.category&&category!==preset.category)throw new Error('这组模板属于其他类目，请选择匹配的组合');
  return {...form,presetId:preset.id,presetCategory:preset.category,category:category||preset.category,templateOne:preset.templateOne,templateTwo:preset.templateTwo,ranges:structuredClone(preset.ranges)};
}
export function changeProductCategory(form,category){
  if(form.presetCategory&&form.presetCategory!==category.trim()){
    return {...form,category,presetId:'',presetCategory:'',templateOne:'',templateTwo:'',ranges:[[65,75],[115,125]]};
  }
  return {...form,category};
}
export function renameSavedTemplate(preset,name){
  name=String(name||'').trim();
  if(!name||name.length>80)throw new Error('请填写80字以内的模板组名称');
  return {name,category:preset.category,templateOne:preset.templateOne,templateTwo:preset.templateTwo,ranges:structuredClone(preset.ranges),expectedUpdatedAt:preset.updatedAt};
}
