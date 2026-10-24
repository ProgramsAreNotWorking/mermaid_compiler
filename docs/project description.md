# Project description

This project is a new solution for mermaid code, its purpose is making diagramming
easier by allowing programmers to import classes in class diagrams, with this a
programmer will be better able to split a class diagram into smaller ones and
import the missing part from each other.

For example, imagine we have a very huge diagram this:

> > Of course this on is just a small diagram that we are using as an example.

```mermaid
classdiagram


  main --> INumber
  Second --|> INumber

  class main {
      <<Class>>
      INumber children;
    }

  class Second {
      <<Class>>
      bool isActive;
    }


  class INumber {
    <<Interface>>
    int number;
    string name;
  }

  class Some {
      <<Class>>
      string thing;
    }
```

We would be able to split that diagram into two parts:

First part:

```mermaid
%%# import ./secondMermaid.mmd
classdiagram
  main --> INumber

  class main {
      <<Class>>
      INumber children;
    }


```

Second part:

> > Lets imagine too that this diagram is in another file called secondMermaid.mmd

```mermaid
classdiagram
  Second --|> INumber

  class Second {
    <<Class>>
    bool isActive;
  }


  class INumber {
    <<Interface>>
    int number;
    string name;
  }

  class Some {
      <<Class>>
      string thing;
    }
```

The result of these two diagrams should be a new file placed in a folder chose
by the user, this new file should be a smart convination of the main file
and all its dependencies and the dependencies of those files in a way that if
I try to compile the first diagram i must have the following result.

```mermaid
classdiagram


  main --> INumber
  Second --|> INumber

  class main {
      <<Class>>
      INumber children;
    }

  class Second {
      <<Class>>
      bool isActive;
    }


  class INumber {
    <<Interface>>
    int number;
    string name;
  }
```

Keep in mind that the merging process should only work with dependencies downwards
and never up words, which means, if a class/component A depends on B and another
class diagram is importing B, A should also be import with his relationship to be,
but if A would be the imported one, B shouldn't be imported and they relationship
should not be considered for the resulting file.

You should know that the compiler must, localize the definitions of classes and
their relationship so it can put them in the merged file.

## Import Rules

The importing rules are simple:

- If a file has a definition of a class and that same class has a definition
  in the imported file, then the definition in the imported file must be ignored.

- If two files import each other, or with any other kind of cycle importation,
  the compilation must fail, with -1 error and notify the user about the problem.

- The importing path must be relative to the path of the importing file.

- The relationship must be in the direction of the dependency, which means that
  the imported class will come with all its dependencies, but it will not take its
  dependents with it.

## Importing direction
