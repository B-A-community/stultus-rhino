import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.ts'

/**
 * Копилка приёмов — самообучение агента.
 *
 * После удачного действия пользователь жмёт «Запомнить приём», модель
 * опрашивает его о параметрах (что должно стать переменным) и сохраняет
 * приём: имя, описание, параметры, Python-код с плейсхолдерами. Дальше
 * названия и описания всех приёмов идут в подсказку, а полный код модель
 * берёт инструментом get_recipe перед применением.
 *
 * Хранится одним JSON-файлом на gateway: копилка общая для бюро, у плагина
 * от неё веса нет.
 */
export interface RecipeParam {
  name: string
  description?: string
  default?: string | number | boolean | null
}

export interface Recipe {
  id: string
  name: string
  description: string
  params: RecipeParam[]
  code: string
  tags: string[]
  at: string
  uses: number
}

let cache: Recipe[] | null = null

function load(): Recipe[] {
  if (cache) return cache
  try {
    cache = existsSync(config.recipesPath) ? (JSON.parse(readFileSync(config.recipesPath, 'utf8')) as Recipe[]) : []
  } catch (error) {
    console.error('[копилка] файл повреждён, начинаю с пустой:', error)
    cache = []
  }
  return cache
}

function persist(): void {
  mkdirSync(dirname(config.recipesPath), { recursive: true })
  writeFileSync(config.recipesPath, JSON.stringify(cache ?? [], null, 2))
}

export function listRecipes(): Recipe[] {
  return load()
}

export function saveRecipe(input: Omit<Recipe, 'id' | 'at' | 'uses'>): Recipe {
  const all = load()
  const name = input.name.trim()
  // Одно имя — один приём: повторное сохранение обновляет.
  const existing = all.find((r) => r.name.toLowerCase() === name.toLowerCase())
  const recipe: Recipe = {
    id: existing?.id ?? randomUUID(),
    name,
    description: input.description.trim(),
    params: input.params ?? [],
    code: input.code,
    tags: input.tags ?? [],
    at: new Date().toISOString(),
    uses: existing?.uses ?? 0,
  }
  if (existing) Object.assign(existing, recipe)
  else all.push(recipe)
  persist()
  return recipe
}

export function getRecipe(name: string): Recipe | undefined {
  const all = load()
  const r = all.find((x) => x.name.toLowerCase() === name.trim().toLowerCase() || x.id === name)
  if (r) {
    r.uses += 1
    persist()
  }
  return r
}

export function deleteRecipe(id: string): boolean {
  const all = load()
  const i = all.findIndex((r) => r.id === id)
  if (i < 0) return false
  all.splice(i, 1)
  persist()
  return true
}

/** Короткий список для подсказки: имя и описание, без кода. */
export function recipesForPrompt(): string {
  const all = load()
  if (!all.length) return ''
  const lines = all.map((r) => `— «${r.name}»: ${r.description}${r.params.length ? ` (параметры: ${r.params.map((p) => p.name).join(', ')})` : ''}`)
  return [
    'КОПИЛКА ПРИЁМОВ БЮРО — стандарт того, как здесь принято строить. Правило ОБЯЗАТЕЛЬНОЕ:',
    'если задача совпадает с приёмом по смыслу (тот же объект, пусть с другими размерами или',
    'количеством), сначала вызови get_recipe, подставь параметры в его код и выполни ИМЕННО ЕГО',
    'через execute_python (для нескольких экземпляров — тот же код в цикле). Свой код пиши только',
    'когда подходящего приёма нет. В ответе упомяни, что применил приём «…».',
    ...lines,
  ].join('\n')
}
