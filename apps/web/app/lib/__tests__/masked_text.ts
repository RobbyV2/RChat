// Rendered markup as it reads, without the reveal controls around masked words.
export const readText = (html: string) =>
  html
    .replace(/<button [^>]*data-masked-word=""[^>]*>([^<]*)<\/button>/g, '$1')
    .replace(
      /<span data-masked-word=""[^>]*><span aria-hidden="true">([^<]*)<\/span><span class="sr-only">masked<\/span><\/span>/g,
      '$1'
    )
