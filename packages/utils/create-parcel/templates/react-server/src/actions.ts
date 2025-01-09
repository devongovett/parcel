'use server';

export let name = '';

export function action(formData: FormData) {
  name = (formData.get('name') as string) || '';
}
